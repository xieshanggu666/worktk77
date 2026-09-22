// 安置点按日补给回归：
// 按实际入住时段核算每日消耗；耐用品/消耗品分账；跨日结转库存与在途物资；
// 人员转出、分批签收、短缺补派、退回同步重算缺口；兼容历史派发；防重复补给
import { setActivePinia, createPinia } from 'pinia'
import { useCommandStore, dispatchParts } from '@/store/command'
import { useTransferStore } from '@/store/transfer'

setActivePinia(createPinia())
const cmd = useCommandStore()
const tr = useTransferStore()
cmd.loadScenario('s1')
tr.load()

let failed = 0
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('  ✗ FAIL:', msg) }
  else console.log('  ✓', msg)
}

const ev = cmd.events.find((e) => e.id === 'ev-001')
const sh2 = tr.shelters.find((s) => s.id === 'sh-2')
const needOf = () => tr.shelterNeeds.find((x) => x.shelter.id === 'sh-2')
const L = () => needOf().ledger

console.log('— 入住时段：100 人入住，当日人·日按实际入住核算 —')
const bt = tr.createBatch({ eventId: ev.id, name: '按日补给批', headcount: 100, vehicleBaseId: 'rb-1', vehicleCount: 3, shelterId: 'sh-2' })
assert(bt.ok, '建立批次 100 人')
tr.register(bt.batch.id, 'pickup', { count: 100 })
tr.register(bt.batch.id, 'checkin', { count: 100 })
assert(needOf().occEnd === 100 && needOf().occ === 100, '当日在住人·日 100、日终在住 100')
// 消耗品 food 0.6/人·日 → 60；耐用品 tent 0.25/人 → 25
assert(L().food.todayDemand === 60, `food 日需求 60，实际 ${L().food.todayDemand}`)
assert(L().tent.todayDemand === 25, `tent 保有需求 25，实际 ${L().tent.todayDemand}`)
assert(needOf().gap.food === 60 && needOf().gap.tent === 25, '首日缺口：food 60 / tent 25')

console.log('— 耐用品/消耗品分账：类别标记正确 —')
assert(L().food.kind === 'consumable' && L().water.kind === 'consumable' && L().medical.kind === 'consumable', 'food/water/medical 为消耗品')
assert(L().tent.kind === 'durable', 'tent 为耐用品')

console.log('— 一键补给：在途预占缺口，重复一键不重复出库 —')
const stockFood = () => cmd.bases.reduce((s, b) => s + (b.stock.food || 0), 0)
const stockTent = () => cmd.bases.reduce((s, b) => s + (b.stock.tent || 0), 0)
const f0 = stockFood(), t0 = stockTent()
const sup = tr.autoSupply('sh-2')
assert(sup.ok, '一键补给成功: ' + JSON.stringify(sup.unmet))
assert(stockFood() === f0 - 60, `food 出库 60（余 ${stockFood()}）`)
assert(stockTent() === t0 - 25, `tent 出库 25（余 ${stockTent()}）`)
assert(sup.sent.every((d) => d.day === 1), '补给记录落账第 1 补给日')
assert(!needOf().gap.food && !needOf().gap.tent, '在途预占后缺口清零')
assert(L().food.inTransit === 60 && L().tent.inTransit === 25, '在途物资入账：food 60 / tent 25')
assert(L().food.carry === 0, '在途未签收前不进结余库存（carry=0）')
const supAgain = tr.autoSupply('sh-2')
assert(!supAgain.ok, '缺口已被在途覆盖，重复一键补给无动作')

console.log('— 分批签收：签收日转当日到货，结余入库 —')
const foodRec = sup.sent.find((d) => d.type === 'food')
cmd.signDispatch(foodRec.id, { qty: 40, receiver: '甲' })
assert(L().food.received === 40 && L().food.inTransit === 20, 'food 实收 40 / 在途 20')
assert(L().food.carry === 0, '当日需求 60：40 已被消耗、在途 20 尚未到货，无结余库存')
assert(!needOf().gap.food, '仍有在途 20，净缺口仍为 0')
cmd.signDispatch(foodRec.id, { qty: 20, receiver: '乙' })
assert(L().food.received === 60 && L().food.inTransit === 0, 'food 全量签收 60 / 在途 0')
const tentRec = sup.sent.find((d) => d.type === 'tent')
cmd.signDispatch(tentRec.id, { qty: 25 })
assert(L().tent.onHand === 25 && L().tent.gap === 0, '耐用品在位 25 顶')

console.log('— 跨日结转：无人员变动时次日按新人·日需求，在途物资跨日预占 —')
tr.advanceSupplyDay(1)
assert(tr.supplyDay === 2, '推进到第 2 补给日')
assert(L().food.todayDemand === 60, '第2日 food 需求 60（新的人·日消耗）')
assert(L().food.carry === 0, '第1日到货 60 恰被当日消耗，无结余跨日')
assert(needOf().gap.food === 60, `第2日为全新一日需再补 60，实际 ${needOf().gap.food}`)
assert(L().tent.onHand === 25 && !needOf().gap.tent, '耐用品跨日在位复用，次日不重复补')

console.log('— 人员转出：消耗品人·日下降，耐用品退出但仍在位可复用 —')
// 第 2 日转出 60 人（当日仍计人·日），第 3 日起只剩 40 人
tr.register(bt.batch.id, 'checkout', { count: 60 })
assert(needOf().occ === 100, '转出当日仍计 100 人·日（当日仍需消耗）')
assert(needOf().occEnd === 40, '日终在住 40')
tr.advanceSupplyDay(1)
assert(needOf().occ === 40 && needOf().occEnd === 40, '第3日在住人·日 40')
assert(L().food.todayDemand === 24, `food 需求降为 24（40×0.6），实际 ${L().food.todayDemand}`)
// 第2日缺口 60 未补（历史缺口结转）+ 第3日需求 24 = 待补 84
assert(L().food.backlogBefore === 60, '第3日承接第2日历史缺口 60')
assert(L().food.backlog === 84, `滚动待补 84（60 历史 + 24 当日），实际 ${L().food.backlog}`)
assert(needOf().gap.food === 84, `净缺口 84，实际 ${needOf().gap.food}`)
assert(L().tent.todayDemand === 10, `tent 日终保有需求降为 10（40×0.25），实际 ${L().tent.todayDemand}`)
assert(L().tent.onHand === 25 && !needOf().gap.tent, '帐篷在位 25 ≥ 需求 10，转出不造成缺口')

console.log('— 跨日在途结转：第3日补 84，先到 24 仅覆盖当日、历史缺口留账 —')
const sup3 = tr.autoSupply('sh-2')
assert(sup3.ok, '第3日一键补给')
const food3 = sup3.sent.filter((d) => d.type === 'food').reduce((s, d) => s + d.qty, 0)
assert(food3 === 84, `按净缺口补 food 84（历史60+当日24），实际 ${food3}`)
assert(sup3.sent.every((d) => d.day === 3), '补派单全部落账第3补给日')
assert(!needOf().gap.food, '在途 84 预占后缺口清零')
// 当日先签 24、其余次日签收 → 第3日历史口径仍有 60 未到货留账
const rec24 = sup3.sent.find((d) => d.type === 'food')
cmd.signDispatch(rec24.id, { qty: Math.min(24, rec24.qty) })
tr.advanceSupplyDay(1)
const lg3 = tr.shelterLedgers['sh-2'].find((r) => r.day === 3).types.food
assert(lg3.backlog === 60, `第3日仅 24 签收：历史缺口 60（第2日欠）留账，实际 ${lg3.backlog}`)
assert(L().food.backlogBefore === 60, '第4日承接历史缺口 60')
// 第4日签收剩余全部在途（60），优先冲抵历史缺口：期末无历史缺口结转，第4日自身 24 另计
sup3.sent.filter((d) => d.type === 'food')
  .forEach((d) => { if (dispatchParts(d).inTransit > 0) cmd.signDispatch(d.id, { qty: dispatchParts(d).inTransit }) })
assert(L().food.backlogBefore === 60, '第4日期初仍承接历史缺口 60')
assert(L().food.backlog === 24, `60 到货冲抵历史缺口后期末仅剩当日 24（历史缺口不再结转），实际 backlog=${L().food.backlog}`)
assert(L().food.todayDemand === 24, `第4日自身 40 人·日需求 24，实际 ${L().food.todayDemand}`)

console.log('— 短缺认定 + 补派：缺口同步重算，防重复补派 —')
// 40 人·日 food 需求 24；先发在途 10 并认定短缺 14（构造一条新在途单）
const sh = tr.shelters.find((x) => x.id === 'sh-2')
const sd = cmd.dispatchToShelter({
  baseId: 'rb-2', shelterId: 'sh-2', shelterName: sh.name, lng: sh.lng, lat: sh.lat, type: 'food', qty: 24
})
cmd.signDispatch(sd.id, { qty: 10, shortQty: 14 })
assert(dispatchParts(sd).shortage === 14 && dispatchParts(sd).shortPending === 14, '认定短缺 14 待补')
const rep = cmd.replenishShortage(sd.id)
assert(rep.ok, '短缺补派成功')
assert(rep.sent.every((d) => d.day === 4), '补派单落账当前补给日(4)')
assert(dispatchParts(sd).shortPending === 0, '已补派量回链原单，待补清零')
const repAgain = cmd.replenishShortage(sd.id)
assert(!repAgain.ok, '无待补短缺，防重复补派')

console.log('— 退回入库：耐用品在途余量退回不改在位、缺口按实重算；撤回释放缺口 —')
// 再建 100 人入住：140 人 tent 需求 35，在位 25 → 缺 10；补一批 30 顶（在途预占缺口）
const bt2 = tr.createBatch({ eventId: ev.id, name: '新增入住批', headcount: 100, vehicleBaseId: 'rb-1', vehicleCount: 3, shelterId: 'sh-2' })
tr.register(bt2.batch.id, 'pickup', { count: 100 })
tr.register(bt2.batch.id, 'checkin', { count: 100 })
assert(L().tent.todayDemand === 35, `140 人 tent 需求 35，实际 ${L().tent.todayDemand}`)
assert(L().tent.onHand === 25 && needOf().gap.tent === 10, `在位 25、缺口 10，实际 ${needOf().gap.tent}`)
const tentExtra = cmd.dispatchToShelter({
  baseId: 'rb-1', shelterId: 'sh-2', shelterName: sh2.name, lng: sh2.lng, lat: sh2.lat, type: 'tent', qty: 30
})
assert(!needOf().gap.tent, '在途 30 预占后帐篷缺口清零')
// 部分签收 18：在位 25+18=43 ≥ 35 已够；在途余 12 退回基地（库存回补、在途清零、不影响在位）
cmd.signDispatch(tentExtra.id, { qty: 18 })
const onHandAfterSign = L().tent.onHand
assert(onHandAfterSign === 43, `部分签收 18 后在位 43，实际 ${onHandAfterSign}`)
const retR = cmd.returnDispatch(tentExtra.id, { qty: 12, reason: '余货退回基地' })
assert(retR.ok && L().tent.returned === 12 && L().tent.returnedFromReceived === 0, '在途余量 12 退回（累计退回账 12、非已签收库存）')
assert(L().tent.onHand === 43 && L().tent.inTransit === 0, `在途退回不冲减在位 43，实际 ${L().tent.onHand}`)
assert(L().tent.sent === 43, `耐用品保障量=在位 43（在途清零），实际 ${L().tent.sent}`)
assert(!needOf().gap.tent, '在位 43 ≥ 需求 35，无缺口')
// 再入住 40 人 → 需求 45（180×0.25），在位 43 → 缺口重开 2
const bt3 = tr.createBatch({ eventId: ev.id, name: '继续入住批', headcount: 40, vehicleBaseId: 'rb-1', vehicleCount: 1, shelterId: 'sh-2' })
tr.register(bt3.batch.id, 'pickup', { count: 40 })
tr.register(bt3.batch.id, 'checkin', { count: 40 })
assert(L().tent.todayDemand === 45 && needOf().gap.tent === 2, `需求 45、在位 43、缺口重开 2，实际 ${needOf().gap.tent}`)
// 在途补给撤回：缺口释放（构造一条在途 water 后撤回）
const waterDemand = L().water.todayDemand // 180 人·日 × 0.2 = 36
const waterGap0 = needOf().gap.water || 0
const sw = cmd.dispatchToShelter({
  baseId: 'rb-2', shelterId: 'sh-2', shelterName: sh2.name, lng: sh2.lng, lat: sh2.lat,
  type: 'water', qty: 100
})
assert(waterDemand === 36, `water 当日需求 36（180×0.2），实际 ${waterDemand}`)
assert(!needOf().gap.water, '在途 water 100 预占后当日缺口清零')
cmd.withdrawDispatch(sw.id)
assert(needOf().gap.water >= waterDemand, `撤回在途后缺口按实重开（≥${waterDemand}），实际 ${needOf().gap.water}`)

console.log('— 兼容历史派发记录：无日期字段按第 1 日全量在途处理 —')
const legacy = {
  id: 'dp-legacy-sup', baseId: 'rb-2', baseName: '绵阳物资储备库',
  shelterId: 'sh-2', shelterName: sh2.name, lng: sh2.lng, lat: sh2.lat,
  type: 'medical', typeLabel: '医疗物资', qty: 50, unit: '件',
  distance: 10, minutes: 20, at: '00:01', color: '#26a69a', source: '旧系统',
  status: 'enroute', via: [], detourBy: null, holdBy: null
  // 故意不携带 day / 闭环字段
}
cmd.dispatches.unshift(legacy)
assert(dispatchParts(legacy).inTransit === 50, '旧补给记录按全量在途兼容')
const medGapBefore = needOf().gap.medical || 0
assert(L().medical.inTransit >= 50 && (needOf().gap.medical || 0) <= Math.max(0, medGapBefore - 50),
  '旧记录在途照常预占当日医疗缺口')
// 旧记录可直接走签收闭环，回执按当前补给日落账
const lr = cmd.signDispatch(legacy.id, { qty: 50 })
assert(lr.ok && L().medical.received >= 50, '旧记录完成签收，实收计入累计到货')

console.log('— 按日台账：逐日人·日/需求/缺口/结转可查 —')
const rows = tr.shelterLedgers['sh-2']
assert(rows.length === 4, `生成 4 日台账，实际 ${rows.length}`)
const r1 = rows.find((r) => r.day === 1)
assert(r1.types.food.demand === 60 && r1.types.food.occ === 100, '台账第1日：100 人·日 / food 需求 60')
assert(r1.types.tent.demand === 25, '台账第1日耐用品需求 25')
const r2 = rows.find((r) => r.day === 2)
assert(r2.types.food.occ === 100 && r2.types.food.backlog === 60, '台账第2日：100 人·日、未补缺口 60 结转')
const r3 = rows.find((r) => r.day === 3)
assert(r3.types.food.occ === 40 && r3.types.food.demand === 24, '台账第3日：转出后 40 人·日 / 需求 24')

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
