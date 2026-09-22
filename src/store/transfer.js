import { defineStore } from 'pinia'
import { useCommandStore, roughPath, pathMetrics, dispatchParts } from '@/store/command'
import { useRoadblockStore } from '@/store/roadblock'
import {
  SHELTERS, SUPPLY_DAILY_COEF, SUPPLY_DURABLE_COEF, SIM_DAY_ANCHOR
} from '@/mock/data'

let batchSeq = 0
let personSeq = 0
const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

// 人员查重键：优先证件号，无证件号用姓名
const personKey = (p) => (p.idNo && p.idNo.trim()) ? 'id:' + p.idNo.trim() : 'nm:' + (p.name || '').trim()

// 补给日历：第 1 日锚点 +（day-1）天
export function supplyDateLabel(day) {
  const d = new Date(SIM_DAY_ANCHOR + 'T00:00:00')
  d.setDate(d.getDate() + Math.max(0, day - 1))
  return `${d.getMonth() + 1}月${d.getDate()}日`
}
// 取记录/回执所属补给日（兼容无日期字段的历史记录：按第 1 日处理）
const recDay = (r) => (Number.isFinite(r?.day) ? r.day : 1)
const logDay = (log, fallback) => (Number.isFinite(log?.day) ? log.day : fallback)

/* ---------- 入住时段 → 每日在住口径（按实际入住/转出日期核算） ---------- */
// 人员在 d 日的入住时段（入住日 ci、转出日 co 均计消耗，含当日入住又转出）：
// [ci, co] 闭区间——入住日与转出日都按全天在住核算每日消耗
function personDaysOn(members, day) {
  let n = 0
  members.forEach((m) => {
    if (!m.checkinAt) return
    const ci = m.checkinDay || 1
    if (!m.checkoutAt) { if (ci <= day) n++ }
    else {
      const co = m.checkoutDay || ci
      if (ci <= day && day <= co) n++
    }
  })
  return n
}
// 日终在住口径（用于耐用品保有需求与床位/在住展示）：
// 已入住、且在 d 日日终尚未转出即在册；无日期字段的历史登记按第 1 日兼容
function occEndOf(members, day) {
  let n = 0
  members.forEach((m) => {
    if (!m.checkinAt) return
    const ci = m.checkinDay || 1
    if (ci > day) return
    // 转出日当日日终已不在册（转出日的白天消耗仍由 personDaysOn 计 1 人·日）
    if (m.checkoutAt && (m.checkoutDay || ci) <= day) return
    n++
  })
  return n
}
// 安置点全部批次（含已办结，历史入住时段仍参与跨日核算）的成员
function shelterMembers(state, shelterId) {
  const list = []
  state.batches.forEach((b) => { if (b.shelterId === shelterId) list.push(...b.members) })
  return list
}

// 按类型汇总安置点物资账（实收按签收日、退回按退回日归集；在途仅计未闭环余量）
function shelterMaterial(records, shelterId, type, today) {
  const recvByDay = {}, retByDay = {}, retFromRecvByDay = {}
  let received = 0, returned = 0, returnedFromReceived = 0, inTransit = 0, held = 0
  records.forEach((d) => {
    if (d.shelterId !== shelterId || d.type !== type) return
    const p = dispatchParts(d)
    received += p.received
    returned += p.returned
    inTransit += p.inTransit
    held += p.heldQty
    ;(d.signLogs || []).forEach((l) => {
      const dy = logDay(l, recDay(d))
      recvByDay[dy] = (recvByDay[dy] || 0) + (l.qty || 0)
    })
    ;(d.returnLogs || []).forEach((l) => {
      const dy = logDay(l, recDay(d))
      const fromR = l.fromReceived != null ? l.fromReceived : 0 // 旧记录无标记按在途退回
      retByDay[dy] = (retByDay[dy] || 0) + (l.qty || 0)
      retFromRecvByDay[dy] = (retFromRecvByDay[dy] || 0) + fromR
      returnedFromReceived += fromR
    })
  })
  return { recvByDay, retByDay, retFromRecvByDay, received, returned, returnedFromReceived, inTransit, held, today }
}

export const useTransferStore = defineStore('transfer', {
  state: () => ({
    shelters: [],    // 安置点（床位容量）
    batches: [],     // 转移批次
    supplyDay: 1     // 当前补给日（按日核算消耗、跨日结转库存与在途物资）
  }),

  getters: {
    /* ---------- 安置点床位 ---------- */
    // shelterId -> { inHouse 在住, reserved 批次计划余量预占, left 剩余可登记 }
    bedMap(state) {
      const m = {}
      state.shelters.forEach((s) => { m[s.id] = { inHouse: 0, reserved: 0, left: s.capacity } })
      state.batches.forEach((b) => {
        if (!b.shelterId || !m[b.shelterId]) return
        const inHouse = b.members.filter((x) => x.checkinAt && !x.checkoutAt).length
        const out = b.members.filter((x) => x.checkoutAt).length
        m[b.shelterId].inHouse += inHouse
        if (b.status !== 'closed') {
          // 计划转移中尚未入住/转出的部分视为床位预占
          m[b.shelterId].reserved += Math.max(0, b.headcount - inHouse - out)
        }
      })
      Object.values(m).forEach((v) => { v.left = Math.max(0, v.left - v.inHouse - v.reserved) })
      return m
    },
    /* ---------- 安置点按日补给核算 ----------
     * 消耗品：按实际入住时段核算每人·日消耗，历史日缺口跨日结转（新到货优先冲抵旧缺口），
     *         跨日结余库存照转；在途物资对当日缺口做预占，签收后才转为实际库存；
     * 耐用品：按日终在住 × 人均保有量补足，在位资产 = 累计实收 − 已签收库存退回，
     *         转出退实物即释放给新入住人员复用，不重复补给；在途余量退回从未到货、不冲减在位；
     * 人员转出 / 分批签收 / 短缺认定补派 / 退回均实时重算；无日期字段的历史派发按第 1 日兼容。 */
    shelterNeeds(state) {
      const cmd = useCommandStore()
      const day = state.supplyDay
      return state.shelters.map((s) => {
        const members = shelterMembers(state, s.id)
        const occToday = personDaysOn(members, day)

        // 消耗品：逐人·日需求，按 缺口结转 + 库存结转 双轨滚动核算
        const cons = {}
        Object.entries(SUPPLY_DAILY_COEF).forEach(([t, coef]) => {
          const ac = shelterMaterial(cmd.dispatches, s.id, t, day)
          let cumDemand = 0, cumRecv = 0
          let backlog = 0, carry = 0 // 上一日结转：待补缺口 / 结余库存（仅按已签收到货滚动）
          const daily = {}
          for (let d = 1; d <= day; d++) {
            const demand = Math.ceil(personDaysOn(members, d) * coef)
            const recv = ac.recvByDay[d] || 0
            const ret = ac.retByDay[d] || 0
            // 历史缺口先吃结转库存与当日到货，余量才进结余；在途物资未签收不进库存
            const applied = carry + recv
            const totalNeed = backlog + demand
            backlog = Math.max(0, totalNeed - applied)
            carry = Math.max(0, applied - totalNeed)
            // 当日在途量只对当日待补缺口做预占（不进跨日结余）
            const gapD = d === day ? Math.max(0, backlog - ac.inTransit) : backlog
            daily[d] = {
              occ: personDaysOn(members, d), demand, recv, ret,
              backlog, carry, gap: gapD, inTransit: d === day ? ac.inTransit : 0
            }
            cumDemand += demand
            cumRecv += recv
          }
          cons[t] = {
            kind: 'consumable',
            coef,
            cumDemand,
            todayDemand: daily[day].demand,
            occToday,
            received: cumRecv,
            inTransit: ac.inTransit,
            held: ac.held,
            returned: ac.returned,
            sent: cumRecv + ac.inTransit, // 保障量（实收+在途，沿用闭环口径）
            carry,                        // 跨日结转结余库存（仅按实收滚动）
            backlog,                      // 按实收口径滚动的累计待补缺口（未含当日在途预占）
            backlogBefore: day > 1 ? daily[day - 1].backlog : 0, // 截至昨日的历史缺口
            gap: daily[day].gap,          // 当日净缺口（已预占在途）
            daily
          }
        })

        // 耐用品：按日终在住保有；在位资产 = 累计实收 - 已签收库存退回
        //   （在途余量从未到货，其退回不冲减在位；转出人员的实物退回即释放复用，不重复补）
        const durable = {}
        Object.entries(SUPPLY_DURABLE_COEF).forEach(([t, coef]) => {
          const ac = shelterMaterial(cmd.dispatches, s.id, t, day)
          let peak = 0
          for (let d = 1; d <= day; d++) peak = Math.max(peak, occEndOf(members, d))
          const occEnd = occEndOf(members, day)
          const need = Math.ceil(occEnd * coef)
          const peakNeed = Math.ceil(peak * coef)
          const onHand = ac.received - ac.returnedFromReceived
          const gap = Math.max(0, need - onHand - ac.inTransit)
          durable[t] = {
            kind: 'durable',
            coef,
            cumDemand: peakNeed,
            todayDemand: need,
            occToday: occEnd,
            received: ac.received,
            inTransit: ac.inTransit,
            held: ac.held,
            returned: ac.returned,
            returnedFromReceived: ac.returnedFromReceived,
            sent: onHand + ac.inTransit,
            onHand,
            peak, peakNeed,
            gap,
            daily: null
          }
        })

        const ledger = { ...cons, ...durable }

        // 汇总口径（兼容原 shelterNeeds 消费方：need/sent/received/gap）
        const need = {}, sent = {}, received = {}, gap = {}
        Object.entries(ledger).forEach(([t, x]) => {
          need[t] = x.todayDemand
          if (x.sent > 0) sent[t] = x.sent
          if (x.received > 0) received[t] = x.received
          if (x.gap > 0) gap[t] = x.gap
        })

        return {
          shelter: s,
          occ: occToday,
          occEnd: occEndOf(members, day),
          need, sent, received, gap,
          ledger,
          types: Object.keys(ledger)
        }
      })
    },

    // 按日台账（第 1 日..当前补给日：在住人·日 / 需求 / 到货 / 退回 / 待补缺口 / 结转结余）
    shelterLedgers(state) {
      const cmd = useCommandStore()
      const m = {}
      this.shelterNeeds.forEach((item) => {
        const sId = item.shelter.id
        const members = shelterMembers(state, sId)
        // 耐用品按日累计实收/退回（回执日落账），还原每个历史日的在位资产
        const durByDay = {}
        Object.entries(SUPPLY_DURABLE_COEF).forEach(([t]) => {
          const rec = [], ret = []
          cmd.dispatches.forEach((d) => {
            if (d.shelterId !== sId || d.type !== t) return
            ;(d.signLogs || []).forEach((l) => { rec.push({ day: logDay(l, recDay(d)), qty: l.qty || 0 }) })
            ;(d.returnLogs || []).forEach((l) => {
              // 仅已签收库存退回冲减在位；在途余量退回不计
              ret.push({ day: logDay(l, recDay(d)), qty: l.fromReceived != null ? l.fromReceived : 0 })
            })
          })
          durByDay[t] = {
            recUpTo: (d) => rec.filter((x) => x.day <= d).reduce((sum, x) => sum + x.qty, 0),
            retUpTo: (d) => ret.filter((x) => x.day <= d).reduce((sum, x) => sum + x.qty, 0)
          }
        })
        const rows = []
        for (let d = 1; d <= state.supplyDay; d++) {
          const row = { day: d, date: supplyDateLabel(d), types: {} }
          Object.entries(item.ledger).forEach(([t, x]) => {
            if (x.kind === 'consumable') {
              row.types[t] = { ...x.daily[d], kind: 'consumable' }
            } else {
              const occ = occEndOf(members, d)
              const demand = Math.ceil(occ * x.coef)
              const recv = durByDay[t].recUpTo(d)
              const rtn = durByDay[t].retUpTo(d)
              const onHand = recv - rtn
              // 历史日在途无法回溯（签收后才落账），台账展示按 在位资产 vs 需求 的净缺口
              const inTransit = d === state.supplyDay ? x.inTransit : 0
              row.types[t] = {
                kind: 'durable', occ, demand, recv, ret: rtn, onHand,
                inTransit, shortage: Math.max(0, demand - onHand - inTransit)
              }
            }
          })
          rows.push(row)
        }
        m[sId] = rows
      })
      return m
    },
    /* ---------- 事件转移进度（回写事件详情） ---------- */
    // eventId -> { batches, planned, picked, checkedIn, out }
    progressByEvent(state) {
      const m = {}
      state.batches.forEach((b) => {
        const p = (m[b.eventId] = m[b.eventId] || { batches: 0, planned: 0, picked: 0, checkedIn: 0, out: 0 })
        p.batches++
        p.planned += b.headcount
        b.members.forEach((x) => {
          if (x.pickupAt) p.picked++
          if (x.checkinAt) p.checkedIn++
          if (x.checkoutAt) p.out++
        })
      })
      return m
    },
    /* ---------- 大屏统计 ---------- */
    stats(state) {
      let inTransit = 0, housed = 0, out = 0, registered = 0
      state.batches.forEach((b) => {
        b.members.forEach((x) => {
          if (x.pickupAt) registered++
          if (x.checkoutAt) out++
          else if (x.checkinAt) housed++
          else if (x.pickupAt) inTransit++
        })
      })
      return {
        activeBatches: state.batches.filter((b) => b.status !== 'closed').length,
        inTransit, housed, out, registered
      }
    }
  },

  actions: {
    load() {
      this.shelters = SHELTERS.map((s) => ({ ...s }))
      this.batches = []
      this.supplyDay = 1
    },

    _cmd() { return useCommandStore() },
    _event(eventId) { return this._cmd().events.find((e) => e.id === eventId) },
    _log(eventId, text) {
      const ev = this._event(eventId)
      if (ev) ev.timeline.push({ at: nowStr(), text })
    },
    _batch(id) { return this.batches.find((b) => b.id === id) },

    /* ---------- 道路阻断处置：挂起 / 绕行 / 续派 ---------- */

    // 重算批次路线 ETA（受灾点 → 途经点 → 安置点）
    _syncEta(b) {
      const ev = this._event(b.eventId)
      const sh = this.shelters.find((s) => s.id === b.shelterId)
      if (!ev || !sh) return
      const pts = [[ev.location.lng, ev.location.lat], ...(b.via || []), [sh.lng, sh.lat]]
      b.eta = pathMetrics(pts)
    },
    // 挂起：车辆与床位预占保留，接运/入住登记暂停，恢复通行后续派
    holdBatch(batchId, blockId) {
      const b = this._batch(batchId)
      if (!b || b.status === 'closed' || b.held) return
      b.held = true
      b.holdBy = blockId
      b.via = []
      b.detourBy = null
      this._log(b.eventId, `⏸ 批次「${b.name}」因道路阻断挂起（车辆/床位预占保留，待续派）`)
    },
    // 续派：解除挂起并恢复直线 ETA
    resumeBatch(batchId) {
      const b = this._batch(batchId)
      if (!b || !b.held) return
      b.held = false
      b.holdBy = null
      b.via = []
      b.detourBy = null
      this._syncEta(b)
      this._log(b.eventId, `▶️ 批次「${b.name}」恢复通行续派，预计 ${b.eta?.minutes}min 抵达安置点`)
    },
    // 绕行改道：写入途经点并重算 ETA（地图转移路线联动更新）
    rerouteBatch(batchId, via, blockId = null, silent = false) {
      const b = this._batch(batchId)
      if (!b || b.status === 'closed') return null
      b.via = via
      b.detourBy = blockId
      this._syncEta(b)
      if (!silent) this._log(b.eventId, `🔀 批次「${b.name}」绕行改道，约 ${b.eta?.distance}km·${b.eta?.minutes}min`)
      return b
    },
    // 阻断解除后恢复直线（由道路阻断模块判定后调用）
    resetBatchRoute(batchId) {
      const b = this._batch(batchId)
      if (!b) return
      b.via = []
      b.detourBy = null
      this._syncEta(b)
    },

    /* ---------- 批次生命周期 ---------- */

    // 指挥员建批：分配车辆（占用资源库车辆库存）与安置点（预占床位）
    createBatch({ eventId, name, headcount, vehicleBaseId, vehicleCount, shelterId }) {
      const cmd = this._cmd()
      const ev = this._event(eventId)
      const base = cmd.bases.find((b) => b.id === vehicleBaseId)
      const shelter = this.shelters.find((s) => s.id === shelterId)
      headcount = Math.max(1, Math.round(headcount || 0))
      vehicleCount = Math.max(1, Math.round(vehicleCount || 0))
      if (!ev || !base || !shelter) return { ok: false, msg: '参数不完整，请检查事件、车辆来源与安置点' }
      if ((base.stock.vehicle || 0) < vehicleCount) {
        return { ok: false, msg: `${base.name} 车辆不足（余 ${base.stock.vehicle || 0} 辆）` }
      }
      const beds = this.bedMap[shelterId]
      if (beds.left < headcount) {
        return { ok: false, msg: `${shelter.name} 剩余床位 ${beds.left}，不足 ${headcount} 人，请减少人数或更换安置点` }
      }
      base.stock.vehicle -= vehicleCount // 占用车辆
      const batch = {
        id: 'tb-' + Date.now() + '-' + ++batchSeq,
        eventId,
        name: name?.trim() || `第${this.batches.filter((b) => b.eventId === eventId).length + 1}批`,
        headcount,
        vehicleBaseId, vehicleCount,
        shelterId,
        vehicleReleased: false,
        status: 'pending',
        members: [],
        createdAt: nowStr(),
        // 道路阻断处置：挂起状态、绕行途经点与预计到达
        held: false, holdBy: null, via: [], detourBy: null, eta: null
      }
      this._syncEta(batch)
      this.batches.unshift(batch)
      // 回写事件：时间线 + 状态联动
      this._log(eventId, `🚌 创建转移批次「${batch.name}」：计划 ${headcount} 人，${base.name} 出车 ${vehicleCount} 辆 → ${shelter.name}`)
      if (ev.status === 'reported' || ev.status === 'assessing') ev.status = 'dispatching'
      // 联动：新建批次立即接受生效阻断复核
      try { useRoadblockStore().assessActive() } catch { /* 道路阻断模块未初始化 */ }
      return { ok: true, batch }
    },

    // 改派：更换安置点 / 调整车辆（释放旧占用、校验新库存与床位）
    reassignBatch(batchId, { shelterId, vehicleBaseId, vehicleCount }) {
      const cmd = this._cmd()
      const b = this._batch(batchId)
      if (!b || b.status === 'closed') return { ok: false, msg: '批次不存在或已办结' }
      const changes = []
      // 换安置点：已有入住登记后不允许（人员已落床位）
      if (shelterId && shelterId !== b.shelterId) {
        if (b.members.some((x) => x.checkinAt)) return { ok: false, msg: '已有群众入住，不能再改派安置点' }
        const target = this.shelters.find((s) => s.id === shelterId)
        if (!target) return { ok: false, msg: '安置点不存在' }
        if (this.bedMap[shelterId].left < b.headcount) {
          return { ok: false, msg: `${target.name} 剩余床位 ${this.bedMap[shelterId].left}，不足 ${b.headcount} 人` }
        }
        changes.push(`安置点改派：${this.shelters.find((s) => s.id === b.shelterId)?.name} → ${target.name}`)
        b.shelterId = shelterId
        b.via = [] // 安置点变更后路线重算
        b.detourBy = null
        this._syncEta(b)
      }
      // 调整车辆：先释放旧占用，再占用新配置
      if (vehicleBaseId && vehicleCount != null) {
        vehicleCount = Math.max(1, Math.round(vehicleCount))
        const oldBase = cmd.bases.find((x) => x.id === b.vehicleBaseId)
        const newBase = cmd.bases.find((x) => x.id === vehicleBaseId)
        if (!newBase) return { ok: false, msg: '车辆来源不存在' }
        const avail = (newBase.stock.vehicle || 0) + (newBase.id === b.vehicleBaseId && !b.vehicleReleased ? b.vehicleCount : 0)
        if (avail < vehicleCount) return { ok: false, msg: `${newBase.name} 车辆不足（可调 ${avail} 辆）` }
        if (oldBase && !b.vehicleReleased) oldBase.stock.vehicle += b.vehicleCount
        newBase.stock.vehicle -= vehicleCount
        b.vehicleReleased = false
        if (vehicleBaseId !== b.vehicleBaseId || vehicleCount !== b.vehicleCount) {
          changes.push(`车辆改派：${newBase.name} ${vehicleCount} 辆`)
        }
        b.vehicleBaseId = vehicleBaseId
        b.vehicleCount = vehicleCount
      }
      if (changes.length) this._log(b.eventId, `🔀 批次「${b.name}」${changes.join('；')}`)
      return { ok: true, msg: changes.length ? changes.join('；') : '配置未变化' }
    },

    // 办结：全部转出或提前办结，回收车辆
    closeBatch(batchId) {
      const b = this._batch(batchId)
      if (!b || b.status === 'closed') return
      const inHouse = b.members.filter((x) => x.checkinAt && !x.checkoutAt).length
      if (inHouse > 0) return { ok: false, msg: `仍有 ${inHouse} 人在住，请先办理转出登记` }
      this._close(b)
      return { ok: true }
    },
    _close(b) {
      b.status = 'closed'
      this._releaseVehicles(b)
      this._log(b.eventId, `✅ 批次「${b.name}」办结：累计转移 ${b.members.length} 人，车辆已回收`)
    },
    _releaseVehicles(b) {
      if (b.vehicleReleased) return
      const base = this._cmd().bases.find((x) => x.id === b.vehicleBaseId)
      if (base) base.stock.vehicle += b.vehicleCount
      b.vehicleReleased = true
    },
    // 取消（仅未开始接运的批次）
    cancelBatch(batchId) {
      const b = this._batch(batchId)
      if (!b) return { ok: false, msg: '批次不存在' }
      if (b.members.length > 0) return { ok: false, msg: '已有登记记录，不能取消，请走办结流程' }
      this._releaseVehicles(b)
      this.batches = this.batches.filter((x) => x.id !== batchId)
      this._log(b.eventId, `🗑 批次「${b.name}」已取消，车辆已释放`)
      return { ok: true }
    },

    /* ---------- 现场登记：接运 / 入住 / 转出 ---------- */

    // 单人登记（带查重）；批量登记传 { count }
    register(batchId, stage, payload) {
      const b = this._batch(batchId)
      if (!b) return { ok: false, msg: '批次不存在' }
      if (b.status === 'closed') return { ok: false, msg: '批次已办结' }
      // 道路阻断挂起中：接运/入住暂停（转出不受影响，在住群众可正常疏解）
      if (b.held && stage !== 'checkout') {
        return { ok: false, msg: '批次因道路阻断挂起中，待恢复通行续派后再登记' }
      }
      if (payload.count != null) return this._registerBulk(b, stage, payload.count)
      const name = (payload.name || '').trim()
      const idNo = (payload.idNo || '').trim()
      if (!name && !idNo) return { ok: false, msg: '请填写姓名或证件号' }
      const person = { name: name || '（未留姓名）', idNo }
      if (stage === 'pickup') return this._pickup(b, person)
      // 入住 / 转出：需先在本批次完成上一环节登记
      const m = b.members.find((x) => personKey(x) === personKey(person))
      if (!m) return { ok: false, msg: stage === 'checkin' ? '该人员未登记接运，请先接运登记' : '该人员未入住，无法转出' }
      if (stage === 'checkin') {
        if (m.checkinAt) return { ok: false, dup: 'self', msg: `「${person.name}」已办理入住，请勿重复登记` }
        return this._checkin(b, [m])
      }
      if (m.checkoutAt) return { ok: false, dup: 'self', msg: `「${person.name}」已办理转出，请勿重复登记` }
      if (!m.checkinAt) return { ok: false, msg: '该人员尚未入住，无法转出' }
      return this._checkout(b, [m])
    },

    _pickup(b, person) {
      const key = personKey(person)
      // 重复登记：本批次已存在
      if (b.members.some((x) => personKey(x) === key)) {
        return { ok: false, dup: 'self', msg: `「${person.name}」已在本批次登记，请勿重复登记` }
      }
      // 重复登记：其他批次已存在 → 提示改派
      for (const ob of this.batches) {
        if (ob.id === b.id || ob.status === 'closed') continue
        const hit = ob.members.find((x) => personKey(x) === key)
        if (hit) {
          return {
            ok: false, dup: 'other',
            fromBatchId: ob.id, fromBatchName: ob.name, personId: hit.id,
            msg: `「${person.name}」已在批次「${ob.name}」登记，可改派至本批次`
          }
        }
      }
      if (b.members.length >= b.headcount) {
        return { ok: false, msg: `已达计划人数 ${b.headcount} 人，请新建批次或调整计划` }
      }
      b.members.push({ id: 'p-' + ++personSeq, ...person, pickupAt: nowStr(), checkinAt: null, checkoutAt: null })
      this._afterRegister(b, 'pickup', `🚌「${person.name}」接运登记`)
      return { ok: true }
    },

    _registerBulk(b, stage, count) {
      count = Math.max(1, Math.round(count || 0))
      if (stage === 'pickup') {
        const room = b.headcount - b.members.length
        const n = Math.min(count, room)
        if (n <= 0) return { ok: false, msg: `已达计划人数 ${b.headcount} 人` }
        for (let i = 0; i < n; i++) {
          b.members.push({ id: 'p-' + ++personSeq, name: `群众${personSeq}号`, idNo: '', anon: true, pickupAt: nowStr(), checkinAt: null, checkoutAt: null })
        }
        this._afterRegister(b, 'pickup', `🚌 批量接运登记 ${n} 人`)
        return { ok: true, msg: n < count ? `仅登记 ${n} 人（受计划人数限制）` : `已登记 ${n} 人` }
      }
      // 批量入住 / 转出：取本批次中处于上一环节的成员
      const pool = stage === 'checkin'
        ? b.members.filter((x) => x.pickupAt && !x.checkinAt)
        : b.members.filter((x) => x.checkinAt && !x.checkoutAt)
      const targets = pool.slice(0, count)
      if (!targets.length) return { ok: false, msg: stage === 'checkin' ? '暂无待入住人员' : '暂无在住人员' }
      return stage === 'checkin' ? this._checkin(b, targets) : this._checkout(b, targets)
    },

    _checkin(b, members) {
      // 可用床位 = 全局剩余 + 本批次自身预占（本批次的待入住人员已计入预占，不能重复扣减）
      const bed = this.bedMap[b.shelterId]
      const inHouse = b.members.filter((x) => x.checkinAt && !x.checkoutAt).length
      const out = b.members.filter((x) => x.checkoutAt).length
      const ownReserved = b.status === 'closed' ? 0 : Math.max(0, b.headcount - inHouse - out)
      const avail = bed.left + ownReserved
      if (avail < members.length) {
        return { ok: false, msg: `${this.shelters.find((s) => s.id === b.shelterId)?.name} 剩余床位 ${avail}，不足 ${members.length} 人，请改派安置点` }
      }
      members.forEach((m) => { m.checkinAt = nowStr(); m.checkinDay = this.supplyDay })
      this._afterRegister(b, 'checkin', `🏕️ 入住登记 ${members.length} 人 → ${this.shelters.find((s) => s.id === b.shelterId)?.name}`)
      return { ok: true, msg: `已入住 ${members.length} 人` }
    },

    _checkout(b, members) {
      members.forEach((m) => {
        m.checkoutAt = nowStr()
        // 转出落账当前补给日；入住当日转出仍计当日 1 人·日（由 personDaysOn 处理）
        m.checkoutDay = Math.max(m.checkinDay || this.supplyDay, this.supplyDay)
      })
      this._afterRegister(b, 'checkout', `🚪 转出登记 ${members.length} 人（返乡/投亲/转院）`)
      return { ok: true, msg: `已转出 ${members.length} 人` }
    },

    // 登记后：推进批次状态、回写事件时间线
    _afterRegister(b, stage, text) {
      const picked = b.members.filter((x) => x.pickupAt).length
      const inDone = b.members.filter((x) => x.checkinAt).length
      const out = b.members.filter((x) => x.checkoutAt).length
      if (b.status === 'pending' && picked > 0) b.status = 'transporting'
      if (b.status === 'transporting' && inDone >= b.headcount) b.status = 'settled'
      this._log(b.eventId, `${text}（批次「${b.name}」${picked}/${b.headcount}）`)
      // 已安置批次的在册人员全部转出 → 自动办结（未满员的批次需手动办结）
      if (b.status === 'settled' && b.members.length > 0 && out === b.members.length) this._close(b)
    },

    // 单成员快捷推进：未入住 → 入住；在住 → 转出（列表行内操作）
    advanceMember(batchId, memberId) {
      const b = this._batch(batchId)
      const m = b?.members.find((x) => x.id === memberId)
      if (!b || !m || b.status === 'closed') return { ok: false, msg: '不可操作' }
      if (!m.checkinAt) return this._checkin(b, [m])
      if (!m.checkoutAt) return this._checkout(b, [m])
      return { ok: false, msg: '该人员已转出' }
    },

    // 人员改派：从原批次移动到目标批次（保留登记进度，校验目标批次计划与床位）
    movePerson(personId, toBatchId) {
      const to = this._batch(toBatchId)
      if (!to || to.status === 'closed') return { ok: false, msg: '目标批次不可用' }
      let from = null, person = null
      for (const b of this.batches) {
        const i = b.members.findIndex((x) => x.id === personId)
        if (i >= 0) { from = b; person = b.members[i]; break }
      }
      if (!from || !person) return { ok: false, msg: '未找到该人员登记记录' }
      if (from.id === to.id) return { ok: false, msg: '人员已在本批次' }
      if (to.members.length >= to.headcount) return { ok: false, msg: `目标批次「${to.name}」已达计划人数` }
      // 已入住人员跨安置点改派：可用床位 = 目标点剩余 + 目标批次自身预占
      if (person.checkinAt && !person.checkoutAt && from.shelterId !== to.shelterId) {
        const inHouse = to.members.filter((x) => x.checkinAt && !x.checkoutAt).length
        const outN = to.members.filter((x) => x.checkoutAt).length
        const ownReserved = Math.max(0, to.headcount - inHouse - outN)
        if (this.bedMap[to.shelterId].left + ownReserved < 1) {
          return { ok: false, msg: `目标安置点剩余床位不足，无法改派` }
        }
      }
      from.members = from.members.filter((x) => x.id !== personId)
      to.members.push(person)
      this._log(from.eventId, `🔀「${person.name}」由批次「${from.name}」改派至「${to.name}」`)
      return { ok: true, msg: `已改派至「${to.name}」` }
    },

    /* ---------- 批次拆分：按人员分组拆出未完成批次 ---------- */

    // 拆分未办结批次：选中的成员带着全部登记历史移入新批次，
    // 新批次独立安排车辆（从基地库存新占）与安置点（床位预占联动重算），
    // 原批次保留剩余成员与车辆配置；两批各自按登记进度重新推导状态与办结条件。
    splitBatch(batchId, { name, personIds, headcount, vehicleBaseId, vehicleCount, shelterId }) {
      const cmd = this._cmd()
      const src = this._batch(batchId)
      if (!src) return { ok: false, msg: '批次不存在' }
      if (src.status === 'closed') return { ok: false, msg: '批次已办结，不能拆分' }
      personIds = Array.isArray(personIds) ? [...new Set(personIds)] : []
      if (!personIds.length) return { ok: false, msg: '请勾选至少一名成员组成新分组' }
      const move = []
      for (const pid of personIds) {
        const m = src.members.find((x) => x.id === pid)
        if (!m) return { ok: false, msg: '勾选成员不属于原批次' }
        if (m.checkoutAt) return { ok: false, msg: `「${m.name}」已转出，不能参与拆分` }
        move.push(m)
      }
      const stay = src.members.filter((x) => !personIds.includes(x.id))
      headcount = Math.max(1, Math.round(headcount || 0))
      vehicleCount = Math.max(1, Math.round(vehicleCount || 0))
      if (headcount < move.length) {
        return { ok: false, msg: `新分组计划人数 ${headcount} 少于勾选成员 ${move.length} 人` }
      }
      // 保留在原批次的成员（含已转出）不能超过原批次剩余计划
      if (src.headcount - headcount < stay.length) {
        return { ok: false, msg: `原批次剩余计划 ${src.headcount - headcount} 人，容不下保留的 ${stay.length} 人，请调大新分组人数或多选成员` }
      }
      // 新分组车辆：从所选基地库存新占（原批次车辆维持原配置，必要时指挥员可再改派）
      const base = cmd.bases.find((x) => x.id === vehicleBaseId)
      if (!base) return { ok: false, msg: '请选择车辆来源' }
      if ((base.stock.vehicle || 0) < vehicleCount) {
        return { ok: false, msg: `${base.name} 车辆不足（余 ${base.stock.vehicle || 0} 辆）` }
      }
      const shelter = this.shelters.find((s) => s.id === shelterId)
      if (!shelter) return { ok: false, msg: '请选择安置点' }
      // 已入住成员必须随原安置点：其床位已实际占用
      const inHouse = move.filter((x) => x.checkinAt && !x.checkoutAt)
      if (inHouse.length && shelterId !== src.shelterId) {
        return { ok: false, msg: `勾选中有 ${inHouse.length} 人已入住「${this.shelters.find((s) => s.id === src.shelterId)?.name}」，不能改投其它安置点（请先转出或取消勾选）` }
      }
      // 换到其它安置点：按当前床位余量校验新分组预占（本分组在目标点尚无预占）
      if (shelterId !== src.shelterId && this.bedMap[shelterId].left < headcount) {
        return { ok: false, msg: `${shelter.name} 剩余床位 ${this.bedMap[shelterId].left}，不足 ${headcount} 人，请减少人数或更换安置点` }
      }

      /* --- 校验通过，执行拆分（床位预占按 headcount 归属重算，getter 自动联动） --- */
      const moveIds = new Set(personIds)
      src.members = src.members.filter((x) => !moveIds.has(x.id))
      src.headcount -= headcount

      const nb = {
        id: 'tb-' + Date.now() + '-' + ++batchSeq,
        eventId: src.eventId,
        name: name?.trim() || `${src.name}-拆${this.batches.filter((b) => b.eventId === src.eventId).length + 1}`,
        headcount,
        vehicleBaseId, vehicleCount,
        shelterId,
        vehicleReleased: false,
        status: 'pending',
        members: move,           // 登记历史（接运/入住/转出时间戳）原样保留
        createdAt: nowStr(),
        splitFrom: src.id,       // 拆分溯源
        // 新分组走全新路线，重新接受阻断评估
        held: false, holdBy: null, via: [], detourBy: null, eta: null
      }
      base.stock.vehicle -= vehicleCount
      this.batches.unshift(nb)

      // 同步两批的办结条件：按各自登记进度重新推导状态
      this._recomputeStatus(src)
      this._recomputeStatus(nb)
      this._syncEta(nb)

      const srcShelterName = this.shelters.find((s) => s.id === src.shelterId)?.name
      this._log(src.eventId, `✂️ 批次「${src.name}」按人员分组拆分出「${nb.name}」：${move.length} 人（${base.name} 出车 ${vehicleCount} 辆 → ${shelter.name}）；原批次剩 ${src.headcount} 人继续 → ${srcShelterName}`)

      // 联动：新分组路线立即接受生效阻断复核（绕行/改派/挂起）
      try { useRoadblockStore().assessActive() } catch { /* 道路阻断模块未初始化 */ }
      return { ok: true, batch: nb, source: src }
    },

    // 按现有登记进度推导批次状态（拆分后同步办结条件）：
    // 无接运 → 待接运；未全部入住 → 接运中；全部入住 → 已安置；
    // 已安置且在册人员全部转出 → 自动办结并回收车辆（满员批次的自动办结规则）
    _recomputeStatus(b) {
      const picked = b.members.filter((x) => x.pickupAt).length
      const checkedIn = b.members.filter((x) => x.checkinAt).length
      if (picked === 0) b.status = 'pending'
      else if (checkedIn < picked || picked < b.headcount) b.status = 'transporting'
      else b.status = 'settled'
      if (b.status === 'settled' && b.members.length > 0 && b.members.every((x) => x.checkoutAt)) {
        this._close(b)
      }
    },

    /* ---------- 安置点物资联动 ---------- */

    // 补给日推进 / 回退（演示用时间轴）：
    // 推进日不改动库存与在途账目——消耗、缺口与结转全部由 shelterNeeds 按实际入住时段重算，
    // 在途物资自动带入新一日继续预占缺口，历史日缺口滚动结转。
    setSupplyDay(day) {
      day = Math.max(1, Math.round(day || 1))
      this.supplyDay = day
    },
    advanceSupplyDay(n = 1) {
      this.supplyDay = Math.max(1, this.supplyDay + Math.round(n || 0))
      return this.supplyDay
    },

    // 一键补给：按当日净缺口（已扣除跨日结余与在途预占）就近调拨，
    // 耐用品与消耗品分账补派；库存不足跨基地拆单，未满足缺口如实返回并继续跨日结转
    autoSupply(shelterId) {
      const cmd = this._cmd()
      const item = this.shelterNeeds.find((x) => x.shelter.id === shelterId)
      if (!item) return { ok: false, msg: '安置点不存在' }
      const gaps = Object.entries(item.gap)
      if (!gaps.length) return { ok: false, msg: '当前无物资缺口（结余与在途已覆盖需求）' }
      const sent = []
      const unmet = []
      gaps.forEach(([type, g]) => {
        let need = g
        const cands = cmd.bases
          .filter((b) => (b.stock[type] || 0) > 0)
          .map((b) => ({ b, path: roughPath(b.lng, b.lat, item.shelter.lng, item.shelter.lat) }))
          .sort((x, y) => x.path.minutes - y.path.minutes)
        for (const c of cands) {
          if (need <= 0) break
          const take = Math.min(need, c.b.stock[type])
          const rec = cmd.dispatchToShelter({
            baseId: c.b.id, shelterId, shelterName: item.shelter.name,
            lng: item.shelter.lng, lat: item.shelter.lat, type, qty: take
          })
          if (rec) { sent.push(rec); need -= take }
        }
        if (need > 0) unmet.push({ type, qty: need })
      })
      // 补给量回写关联事件时间线（该安置点服务的未办结批次所属事件）
      const evIds = [...new Set(this.batches.filter((b) => b.shelterId === shelterId && b.status !== 'closed').map((b) => b.eventId))]
      evIds.forEach((id) => this._log(id, `📦 安置点「${item.shelter.name}」第${this.supplyDay}补给日一键补给 ${sent.length} 批物资`
        + (unmet.length ? `，${unmet.length} 类库存不足缺口结转` : '')))
      return { ok: true, sent, unmet }
    }
  }
})
