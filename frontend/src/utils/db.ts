/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbseisarray，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（规程 → 台阵 → 台站 → 仪器 → 标定 / 更换）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie';
import type { SeisArray } from '@/types/array';
import type { SeisStation } from '@/types/station';
import type { Instrument, InstrumentType } from '@/types/instrument';
import type {
  Calibration,
} from '@/types/calibration';
import type { Replace } from '@/types/replace';
import type { VerificationRegulation, VerdictBasis } from '@/types/regulation';
import { judgeAgainst } from '@/utils/calibration';
import { backfillLegacyBinding } from '@/utils/calibration';

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3;

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbseisarray';

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbseisarray:db-version',
  lastBackupAt: 'gbseisarray:last-backup-at',
  lastArrayId: 'gbseisarray:last-array-id',
} as const;

/** 备份文件结构，供 utils/export.ts 与几何页使用 */
export interface BackupPayload {
  app: 'gbseisarray';
  dbVersion: number;
  exportedAt: string;
  regulations: VerificationRegulation[];
  arrays: SeisArray[];
  stations: SeisStation[];
  instruments: Instrument[];
  calibrations: Calibration[];
  replaces: Replace[];
}

export class SeisArrayDatabase extends Dexie {
  regulations!: Table<VerificationRegulation, string>;
  arrays!: Table<SeisArray, string>;
  stations!: Table<SeisStation, string>;
  instruments!: Table<Instrument, string>;
  calibrations!: Table<Calibration, string>;
  replaces!: Table<Replace, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      arrays: 'id, name, state',
      stations: 'id, arrayId, code',
      instruments: 'id, stationId, serialNo, state',
      calibrations: 'id, instrumentId, date',
      replaces: 'id, instrumentId, state',
    });

    // v2：补齐筛选与统计需要的索引（孔径/布设日期、经纬度/基岩、类型/序列号、灵敏度/结论、原因）
    this.version(2).stores({
      arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
      stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
      instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
      calibrations: 'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, updatedAt',
      replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
    });

    // v3：检定规程与标定分家。
    // - 新增 regulations 表（计量站维护：规程号/版次/生效起止/类型判据）；
    // - 标定增加趟次号、规程引用、绑定状态、判据快照索引；
    // - 旧数据没记规程号，按标定日期回填当时生效版本；对不上的置只读保留。
    this.version(DB_VERSION)
      .stores({
        regulations: 'id, regulationCode, edition, status, effectiveFrom, effectiveTo',
        arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
        stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
        instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
        calibrations:
          'id, instrumentId, date, tripNo, sensitivity, selfNoise, responseVerdict, regulationId, regulationCode, bindStatus, updatedAt',
        replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
      })
      .upgrade(async (tx) => {
        // v1 旧字段兜底（只补缺失键，不覆盖 v2 已有值）
        const defaults: Array<[string, () => Record<string, unknown>]> = [
          ['arrays', () => ({ apertureKm: 0, stationCount: 0, department: '' })],
          ['stations', () => ({ lat: 0, lng: 0, elevM: 0, bedrock: '花岗岩', siteNote: '' })],
          ['instruments', () => ({ type: '宽频带', model: '', state: '在用', remark: '' })],
          ['calibrations', () => ({ sensitivity: 0, selfNoise: 0, responseVerdict: '待判定', agency: '' })],
          ['replaces', () => ({ state: '待更换', newSerialNo: '', operator: '' })],
        ];
        for (const [tableName, factory] of defaults) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now();
              if (typeof row.createdAt !== 'number') row.createdAt = now;
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt;
              const fallback = factory();
              Object.keys(fallback).forEach((key) => {
                if (row[key] === undefined) row[key] = fallback[key];
              });
            });
        }

        // 灌入规程基线版本（旧版 + 新版）
        const seedRegulations = buildSeedRegulations(Date.now());
        await tx.table('regulations').bulkPut(seedRegulations);
        const regulationsById = new Map(seedRegulations.map((item) => [item.id, item] as const));
        const instrumentType = new Map<string, string>();
        await tx
          .table('instruments')
          .toCollection()
          .each((instrument: Instrument) => {
            instrumentType.set(instrument.id, instrument.type);
          });

        // 旧标定回填：按日期定位当时版本，并补趟次号（同日同机构归为同趟）
        const tripKeys = new Map<string, string>();
        await tx
          .table('calibrations')
          .toCollection()
          .modify((row: Calibration) => {
            const now = Date.now();
            const date = typeof row.date === 'string' ? row.date : '1970-01-01';
            const agencyKey = String((row as { agency?: string }).agency ?? '');
            const tripGroupKey = `${date}|${agencyKey}`;
            let tripNo = tripKeys.get(tripGroupKey);
            if (!tripNo) {
              const suffix = agencyKey.slice(0, 2) || 'OLD';
              tripNo = `PC${date.replace(/-/g, '')}-${suffix}`;
              tripKeys.set(tripGroupKey, tripNo);
            }
            row.tripNo = tripNo;

            const backfill = backfillLegacyBinding(seedRegulations, { date });
            row.regulationId = backfill.regulationId;
            row.regulationCode = backfill.regulationCode;
            row.bindStatus = backfill.bindStatus;
            row.judgeError = backfill.bindStatus === 'readonlyMismatch' ? '升级回填未匹配到当日生效规程，只读保留' : '';
            row.verdictBasis = null;
            // 已出结论的照旧保留，并补写依据哪版（固化当时的判据快照）
            if (backfill.bindStatus === 'bound' && row.responseVerdict !== '待判定' && backfill.regulationId) {
              const regulation = regulationsById.get(backfill.regulationId) ?? null;
              const type = instrumentType.get(row.instrumentId) ?? '宽频带';
              const criterion = regulation?.criteria[type as InstrumentType] ?? null;
              if (regulation && criterion) {
                const basis: VerdictBasis = {
                  regulationId: regulation.id,
                  regulationCode: regulation.regulationCode,
                  edition: regulation.edition,
                  mode: 'on-date',
                  criterion: { ...criterion },
                  judgedAt: typeof row.updatedAt === 'number' ? row.updatedAt : now,
                };
                row.verdictBasis = basis;
              } else {
                // 旧版未覆盖该类型：结论保留但无快照，列入只读
                row.bindStatus = 'readonlyMismatch';
                row.regulationId = null;
                row.regulationCode = backfill.regulationCode;
                row.judgeError = '当时生效规程未覆盖该仪器类型，只读保留';
              }
            }
            // 引用到的旧版已作废且未出结论的，按新版挂起重判（基线切换日 2024-07-01 之后仍待判定者）
            if (
              backfill.bindStatus === 'bound' &&
              row.responseVerdict === '待判定' &&
              backfill.regulationId === 'reg_seis_2015'
            ) {
              row.bindStatus = 'pendingRejudge';
              row.judgeError = '所依据 2015 版已换版作废，等待按 2024 版重判';
            }
            row.updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : now;
          });
      });
  }
}

export const db = new SeisArrayDatabase();

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 订阅单表变化（Dexie liveQuery），返回取消订阅函数 */
export function watchTable<T>(
  table: () => Table<T, string>
): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray());
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([]),
      });
      return () => subscription.unsubscribe();
    },
  };
}

/* ------------------------------ 规程播种 ------------------------------ */

/**
 * 规程基线（计量站口径）：
 * - JJG(地震)860《地震观测仪器检定规程》2015 版：2015-01-01 ~ 2024-06-30，已作废；
 * - 同规程号 2024 版：2024-07-01 起生效，计量站换检定规程后各类型灵敏度与自噪上限均有调整。
 * 规程号跨版稳定，年份体现在版次上。
 */
export function buildSeedRegulations(now: number): VerificationRegulation[] {
  const oldCriteria = {
    宽频带: { sensitivityMin: 800, sensitivityMax: 3000, selfNoiseLimit: 3.5 },
    短周期: { sensitivityMin: 100, sensitivityMax: 800, selfNoiseLimit: 3.5 },
    强震: { sensitivityMin: 0.1, sensitivityMax: 5, selfNoiseLimit: 3.5 },
  } as VerificationRegulation['criteria'];
  const newCriteria = {
    宽频带: { sensitivityMin: 900, sensitivityMax: 2800, selfNoiseLimit: 3.0 },
    短周期: { sensitivityMin: 120, sensitivityMax: 750, selfNoiseLimit: 3.0 },
    强震: { sensitivityMin: 0.2, sensitivityMax: 4.5, selfNoiseLimit: 2.5 },
  } as VerificationRegulation['criteria'];
  return [
    {
      id: 'reg_seis_2015',
      regulationCode: 'JJG(地震)860',
      edition: '2015 版',
      name: '地震观测仪器检定规程（宽频带 / 短周期 / 强震）',
      issuer: '省地震局计量站',
      effectiveFrom: '2015-01-01',
      effectiveTo: '2024-06-30',
      status: '已作废',
      criteria: oldCriteria,
      remark: '已被同规程号 2024 版替代；历史标定结论照旧保留。',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'reg_seis_2024',
      regulationCode: 'JJG(地震)860',
      edition: '2024 版',
      name: '地震观测仪器检定规程（宽频带 / 短周期 / 强震）',
      issuer: '省地震局计量站',
      effectiveFrom: '2024-07-01',
      effectiveTo: null,
      status: '生效中',
      criteria: newCriteria,
      remark: '换检定规程后各类型灵敏度区间收窄、自噪上限下调。',
      createdAt: now,
      updatedAt: now,
    },
  ];
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedCalibration {
  id: string;
  instrumentId: string;
  date: string;
  /** 同趟出车共用趟次号 */
  tripNo: string;
  /** 计量站规程号（标定当天须有生效版） */
  regulationCode: string;
  sensitivity: number;
  selfNoise: number;
  operator: string;
  agency: string;
  remark: string;
}

interface SeedInstrument {
  id: string;
  stationId: string;
  type: Instrument['type'];
  model: string;
  serialNo: string;
  installDate: string;
  state: Instrument['state'];
  remark: string;
  calibrations: SeedCalibration[];
}

interface SeedStation {
  id: string;
  arrayId: string;
  code: string;
  lat: number;
  lng: number;
  elevM: number;
  bedrock: SeisStation['bedrock'];
  siteNote: string;
  instruments: SeedInstrument[];
}

interface SeedArray {
  id: string;
  name: string;
  apertureKm: number;
  deployDate: string;
  state: SeisArray['state'];
  department: string;
  stations: SeedStation[];
}

const REG_CODE_2015 = 'JJG(地震)860';
const REG_CODE_2024 = 'JJG(地震)860';

/**
 * 播种演示数据：2 个规程版本 → 2 个台阵 → 5 个台站 → 8 台仪器 → 16 条标定 + 3 条更换。
 * 刻意包含：
 * - 同趟出车多台共用趟次号（海西 HX01 两台 2024-09-30 同趟）；
 * - 一次旧版下的不合格（自噪 4.8 > 3.5）；
 * - 一条换版后挂起待重判（2024-07-01 后录入、待判定）；
 * - 一条对不上账的旧数据（规程号查无、只读保留）。
 */
export function buildSeedArrays(): SeedArray[] {
  return [
    {
      id: 'arr_ltx',
      name: '龙门峡流动台阵',
      apertureKm: 24.6,
      deployDate: '2021-04-18',
      state: '运行中',
      department: '省地震局监测中心',
      stations: [
        {
          id: 'stn_ltx_01',
          arrayId: 'arr_ltx',
          code: 'LTX01',
          lat: 30.8421,
          lng: 103.5624,
          elevM: 1180,
          bedrock: '花岗岩',
          siteNote: '基岩出露，噪声本底低',
          instruments: [
            {
              id: 'ins_ltx01_bb',
              stationId: 'stn_ltx_01',
              type: '宽频带',
              model: 'CMG-3ESPC',
              serialNo: 'CMG-3E-20210418-01',
              installDate: '2021-04-18',
              state: '在用',
              remark: '主用宽频带，配 24 位采集器',
              calibrations: [
                {
                  id: 'cal_ltx01_bb_1',
                  instrumentId: 'ins_ltx01_bb',
                  date: '2023-04-20',
                  tripNo: 'PC20230420-LTX',
                  regulationCode: REG_CODE_2015,
                  sensitivity: 1502.4,
                  selfNoise: 1.82,
                  operator: '陈立群',
                  agency: '省地震局计量站',
                  remark: '响应曲线平滑（2015 版判定）',
                },
                {
                  id: 'cal_ltx01_bb_2',
                  instrumentId: 'ins_ltx01_bb',
                  date: '2024-04-12',
                  tripNo: 'PC20240412-LTX',
                  regulationCode: REG_CODE_2015,
                  sensitivity: 1468.9,
                  selfNoise: 1.95,
                  operator: '陈立群',
                  agency: '省地震局计量站',
                  remark: '灵敏度略降 2.2%，仍在限内（2015 版）',
                },
              ],
            },
            {
              id: 'ins_ltx01_st',
              stationId: 'stn_ltx_01',
              type: '短周期',
              model: 'FSS-3B',
              serialNo: 'FSS3B-20210418-02',
              installDate: '2021-04-18',
              state: '待标定',
              remark: '备份仪器，已逾标定周期',
              calibrations: [
                {
                  id: 'cal_ltx01_st_1',
                  instrumentId: 'ins_ltx01_st',
                  date: '2022-05-06',
                  tripNo: 'PC20220506-LTX',
                  regulationCode: REG_CODE_2015,
                  sensitivity: 412.6,
                  selfNoise: 2.4,
                  operator: '周渝',
                  agency: '省地震局计量站',
                  remark: '首次标定（2015 版）',
                },
              ],
            },
          ],
        },
        {
          id: 'stn_ltx_02',
          arrayId: 'arr_ltx',
          code: 'LTX02',
          lat: 30.9187,
          lng: 103.6412,
          elevM: 1425,
          bedrock: '玄武岩',
          siteNote: '半山台基，交通便利',
          instruments: [
            {
              id: 'ins_ltx02_bb',
              stationId: 'stn_ltx_02',
              type: '宽频带',
              model: 'Trillium-120',
              serialNo: 'T120-20220315-07',
              installDate: '2022-03-15',
              state: '在用',
              remark: '井下安装，深度 42 m',
              calibrations: [
                {
                  id: 'cal_ltx02_bb_1',
                  instrumentId: 'ins_ltx02_bb',
                  date: '2024-03-18',
                  tripNo: 'PC20240318-LTX02',
                  regulationCode: REG_CODE_2015,
                  sensitivity: 1204.8,
                  selfNoise: 1.42,
                  operator: '林之遥',
                  agency: '省地震局计量站',
                  remark: '响应一致性良好（2015 版）',
                },
              ],
            },
            {
              id: 'ins_ltx02_st',
              stationId: 'stn_ltx_02',
              type: '短周期',
              model: 'L-4C-3D',
              serialNo: 'L4C-20220315-08',
              installDate: '2022-03-15',
              state: '已停用',
              remark: '2024 年雷击损坏，已提交更换',
              calibrations: [
                {
                  id: 'cal_ltx02_st_1',
                  instrumentId: 'ins_ltx02_st',
                  date: '2023-03-10',
                  tripNo: 'PC20230310-LTX02',
                  regulationCode: REG_CODE_2015,
                  sensitivity: 265.2,
                  selfNoise: 4.8,
                  operator: '周渝',
                  agency: '省地震局计量站',
                  remark: '自噪超标，2015 版判定不合格（旧版结论保留）',
                },
              ],
            },
          ],
        },
        {
          id: 'stn_ltx_03',
          arrayId: 'arr_ltx',
          code: 'LTX03',
          lat: 30.7802,
          lng: 103.4987,
          elevM: 986,
          bedrock: '石灰岩',
          siteNote: '河谷阶地，需注意汛期供电',
          instruments: [
            {
              id: 'ins_ltx03_bb',
              stationId: 'stn_ltx_03',
              type: '宽频带',
              model: 'STS-2.5',
              serialNo: 'STS25-20230902-11',
              installDate: '2023-09-02',
              state: '在用',
              remark: '新建站首台仪器',
              calibrations: [
                {
                  id: 'cal_ltx03_bb_1',
                  instrumentId: 'ins_ltx03_bb',
                  date: '2024-09-05',
                  tripNo: 'PC20240905-LTX03',
                  regulationCode: REG_CODE_2024,
                  sensitivity: 2251.3,
                  selfNoise: 2.05,
                  operator: '林之遥',
                  agency: '省地震局计量站',
                  remark: '脉冲响应合格（2024 版）',
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'arr_hx',
      name: '海西宽频带台阵',
      apertureKm: 46.2,
      deployDate: '2019-09-25',
      state: '运行中',
      department: '国家测震台网中心',
      stations: [
        {
          id: 'stn_hx_01',
          arrayId: 'arr_hx',
          code: 'HX01',
          lat: 25.4321,
          lng: 119.3421,
          elevM: 62,
          bedrock: '花岗岩',
          siteNote: '海岛台，防盐雾处理',
          instruments: [
            {
              id: 'ins_hx01_bb',
              stationId: 'stn_hx_01',
              type: '宽频带',
              model: 'Trillium-Compact',
              serialNo: 'TC-20190925-03',
              installDate: '2019-09-25',
              state: '在用',
              remark: '海岛主用观测设备',
              calibrations: [
                {
                  id: 'cal_hx01_bb_1',
                  instrumentId: 'ins_hx01_bb',
                  date: '2023-09-28',
                  tripNo: 'PC20230928-HX',
                  regulationCode: REG_CODE_2015,
                  sensitivity: 1498.2,
                  selfNoise: 2.25,
                  operator: '陈立群',
                  agency: '国家测震台网计量中心',
                  remark: '响应合格（2015 版）',
                },
                // 2024-09-30 与同台强震仪同趟出车，共用趟次号、同落 2024 版
                {
                  id: 'cal_hx01_bb_2',
                  instrumentId: 'ins_hx01_bb',
                  date: '2024-09-30',
                  tripNo: 'PC20240930-HX01',
                  regulationCode: REG_CODE_2024,
                  sensitivity: 1483.6,
                  selfNoise: 2.42,
                  operator: '陈立群',
                  agency: '国家测震台网计量中心',
                  remark: '变化 0.97%，2024 版合格',
                },
              ],
            },
            {
              id: 'ins_hx01_sm',
              stationId: 'stn_hx_01',
              type: '强震',
              model: 'ES-T',
              serialNo: 'EST-20190925-04',
              installDate: '2019-09-25',
              state: '在用',
              remark: '结构台阵强震观测',
              calibrations: [
                {
                  id: 'cal_hx01_sm_1',
                  instrumentId: 'ins_hx01_sm',
                  date: '2024-09-30',
                  tripNo: 'PC20240930-HX01',
                  regulationCode: REG_CODE_2024,
                  sensitivity: 1.24,
                  selfNoise: 1.05,
                  operator: '周渝',
                  agency: '国家测震台网计量中心',
                  remark: '强震通道合格，与同台宽频带同趟（2024 版）',
                },
              ],
            },
          ],
        },
        {
          id: 'stn_hx_02',
          arrayId: 'arr_hx',
          code: 'HX02',
          lat: 25.2894,
          lng: 119.5112,
          elevM: 128,
          bedrock: '砂岩',
          siteNote: '覆盖层较厚，需做场地响应校正',
          instruments: [
            {
              id: 'ins_hx02_bb',
              stationId: 'stn_hx_02',
              type: '宽频带',
              model: 'CMG-3ESPC',
              serialNo: 'CMG-3E-20190926-05',
              installDate: '2019-09-26',
              state: '待标定',
              remark: '夜间自噪抬升，待复标',
              calibrations: [
                {
                  id: 'cal_hx02_bb_1',
                  instrumentId: 'ins_hx02_bb',
                  date: '2023-06-11',
                  tripNo: 'PC20230611-HX02',
                  regulationCode: REG_CODE_2015,
                  sensitivity: 1388.4,
                  selfNoise: 3.9,
                  operator: '林之遥',
                  agency: '国家测震台网计量中心',
                  remark: '自噪高于上限，2015 版判定不合格',
                },
              ],
            },
          ],
        },
      ],
    },
  ];
}

/** 换版后挂起待重判的样例（引用已作废 2015 版、未出结论，可按 2024 版一键重判） */
function buildPendingSeedCalibration(): SeedCalibration & { instrumentId: string } {
  return {
    id: 'cal_ltx03_bb_pending',
    instrumentId: 'ins_ltx03_bb',
    date: '2024-06-28',
    tripNo: 'PC20240628-LTX03',
    regulationCode: REG_CODE_2015,
    sensitivity: 2780,
    selfNoise: 3.2,
    operator: '林之遥',
    agency: '省地震局计量站',
    remark: '换版前最后一趟录入，报告结论未出，挂起按 2024 版重判',
  };
}

/** 对不上账的旧数据样例：规程号在规程库中查无，只读保留 */
function buildMismatchSeedCalibration(): SeedCalibration & { instrumentId: string } {
  return {
    id: 'cal_hx02_bb_legacy_mismatch',
    instrumentId: 'ins_hx02_bb',
    date: '2014-05-09',
    tripNo: 'PC20140509-HX02',
    regulationCode: 'JJG(地震)860-2004',
    sensitivity: 1320,
    selfNoise: 3.1,
    operator: '佚名',
    agency: '国家测震台网计量中心',
    remark: '早期纸质台账转录，规程版本在库中缺失，对不上账只读保留',
  };
}

export async function seedDemoData(): Promise<void> {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const daysAgo = (days: number): string => new Date(now - days * 86400000).toISOString().slice(0, 10);

  const regulations = buildSeedRegulations(now);
  const regulationById = new Map(regulations.map((item) => [item.id, item] as const));
  const regulationByCodeDate = (code: string, date: string): VerificationRegulation | null => {
    const found = regulations
      .filter((item) => item.regulationCode === code && item.effectiveFrom <= date && (item.effectiveTo === null || item.effectiveTo >= date))
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    return found ?? null;
  };

  const arrays = buildSeedArrays();

  const replaces: Replace[] = [
    {
      id: 'rpl_ltx02_st',
      instrumentId: 'ins_ltx02_st',
      reason: '雷击导致仪器损坏，标定不合格',
      newSerialNo: 'L4C-20250301-21',
      date: today,
      state: '待更换',
      operator: '周渝',
      remark: '新仪器已到货，待停电窗口安装',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'rpl_hx02_bb',
      instrumentId: 'ins_hx02_bb',
      reason: '自噪持续超标，按台网要求整机更换',
      newSerialNo: 'CMG-3E-20250410-33',
      date: daysAgo(20),
      state: '已更换',
      operator: '林之遥',
      remark: '已完成安装，待复核标定',
      createdAt: now - 20 * 86400000,
      updatedAt: now - 18 * 86400000,
    },
    {
      id: 'rpl_ltx01_st',
      instrumentId: 'ins_ltx01_st',
      reason: '超期未标定，更换为新型号',
      newSerialNo: 'FSS3B-20250506-24',
      date: daysAgo(60),
      state: '已复核',
      operator: '陈立群',
      remark: '复核标定合格，序列号已回写',
      createdAt: now - 60 * 86400000,
      updatedAt: now - 30 * 86400000,
    },
  ];

  await db.transaction(
    'rw',
    [db.regulations, db.arrays, db.stations, db.instruments, db.calibrations, db.replaces],
    async () => {
      const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + offset,
        updatedAt: now + offset,
      });

      const arrayRows: SeisArray[] = [];
      const stationRows: SeisStation[] = [];
      const instrumentRows: Instrument[] = [];
      const calibrationRows: Calibration[] = [];

      const appendCalibration = (
        seed: SeedCalibration,
        type: InstrumentType,
        offset: number
      ): void => {
        const regulation = regulationByCodeDate(seed.regulationCode, seed.date);
        const stampPair = stamp(offset);
        if (!regulation) {
          // 对不上账：只读保留，不出结论
          calibrationRows.push({
            id: seed.id,
            instrumentId: seed.instrumentId,
            date: seed.date,
            tripNo: seed.tripNo,
            sensitivity: seed.sensitivity,
            selfNoise: seed.selfNoise,
            responseVerdict: '待判定',
            regulationId: null,
            regulationCode: seed.regulationCode,
            bindStatus: 'readonlyMismatch',
            verdictBasis: null,
            judgeError: `规程号 ${seed.regulationCode} 在 ${seed.date} 无生效版本，只读保留`,
            operator: seed.operator,
            agency: seed.agency,
            remark: seed.remark,
            ...stampPair,
          });
          return;
        }
        const outcome = judgeAgainst(
          regulation,
          { type, sensitivity: seed.sensitivity, selfNoise: seed.selfNoise },
          'on-date'
        );
        const pending = outcome.verdict === '待判定' || !outcome.basis;
        calibrationRows.push({
          id: seed.id,
          instrumentId: seed.instrumentId,
          date: seed.date,
          tripNo: seed.tripNo,
          sensitivity: seed.sensitivity,
          selfNoise: seed.selfNoise,
          responseVerdict: outcome.verdict,
          regulationId: regulation.id,
          regulationCode: regulation.regulationCode,
          bindStatus: pending ? 'pendingRejudge' : 'bound',
          verdictBasis: outcome.basis,
          judgeError: pending ? outcome.error || '未得出结论，待重判' : '',
          operator: seed.operator,
          agency: seed.agency,
          remark: seed.remark,
          ...stampPair,
        });
      };

      arrays.forEach((seed, arrayIndex) => {
        const { stations, ...arrayRest } = seed;
        arrayRows.push({ ...arrayRest, stationCount: stations.length, ...stamp(arrayIndex) });
        stations.forEach((stationSeed, stationIndex) => {
          const { instruments, ...stationRest } = stationSeed;
          stationRows.push({ ...stationRest, ...stamp(100 + arrayIndex * 100 + stationIndex) });
          instruments.forEach((instrumentSeed, instrumentIndex) => {
            const { calibrations, ...instrumentRest } = instrumentSeed;
            instrumentRows.push({
              ...instrumentRest,
              ...stamp(200 + arrayIndex * 200 + stationIndex * 50 + instrumentIndex),
            });
            calibrations.forEach((calibrationSeed, calibrationIndex) => {
              appendCalibration(
                calibrationSeed,
                instrumentRest.type,
                400 + arrayIndex * 400 + stationIndex * 100 + instrumentIndex * 20 + calibrationIndex
              );
            });
          });
        });
      });

      // 换版后挂起样例：绑旧版、未出结论
      const pendingSeed = buildPendingSeedCalibration();
      {
        const pendingRegulation = regulationById.get('reg_seis_2015');
        calibrationRows.push({
          id: pendingSeed.id,
          instrumentId: pendingSeed.instrumentId,
          date: pendingSeed.date,
          tripNo: pendingSeed.tripNo,
          sensitivity: pendingSeed.sensitivity,
          selfNoise: pendingSeed.selfNoise,
          responseVerdict: '待判定',
          regulationId: pendingRegulation?.id ?? null,
          regulationCode: REG_CODE_2015,
          bindStatus: 'pendingRejudge',
          verdictBasis: null,
          judgeError: '2015 版已换版作废，等待按 2024 版重判（灵敏度 2780 在新版将判不合格）',
          operator: pendingSeed.operator,
          agency: pendingSeed.agency,
          remark: pendingSeed.remark,
          ...stamp(900),
        });
      }

      // 对不上账样例
      const mismatchSeed = buildMismatchSeedCalibration();
      calibrationRows.push({
        id: mismatchSeed.id,
        instrumentId: mismatchSeed.instrumentId,
        date: mismatchSeed.date,
        tripNo: mismatchSeed.tripNo,
        sensitivity: mismatchSeed.sensitivity,
        selfNoise: mismatchSeed.selfNoise,
        responseVerdict: '待判定',
        regulationId: null,
        regulationCode: mismatchSeed.regulationCode,
        bindStatus: 'readonlyMismatch',
        verdictBasis: null,
        judgeError: `规程号 ${mismatchSeed.regulationCode} 在库中缺失，对不上账只读保留`,
        operator: mismatchSeed.operator,
        agency: mismatchSeed.agency,
        remark: mismatchSeed.remark,
        ...stamp(901),
      });

      await db.regulations.bulkPut(regulations);
      await db.arrays.bulkPut(arrayRows);
      await db.stations.bulkPut(stationRows);
      await db.instruments.bulkPut(instrumentRows);
      await db.calibrations.bulkPut(calibrationRows);
      await db.replaces.bulkPut(replaces);
    }
  );
}

/** 打开数据库并幂等播种：仅当台阵表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open();
  const count = await db.arrays.count();
  if (count === 0) {
    // 新库：规程表也要确保有基线（升级路径不会执行时的兜底）
    const regulationCount = await db.regulations.count();
    if (regulationCount === 0) {
      await db.regulations.bulkPut(buildSeedRegulations(Date.now()));
    }
    await seedDemoData();
  }
  stampDbVersion();
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.regulations, db.arrays, db.stations, db.instruments, db.calibrations, db.replaces],
    async () => {
      await Promise.all([
        db.regulations.clear(),
        db.arrays.clear(),
        db.stations.clear(),
        db.instruments.clear(),
        db.calibrations.clear(),
        db.replaces.clear(),
      ]);
    }
  );
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDemoData();
}

/** 统计各表行数，供页脚概览与几何页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [regulations, arrays, stations, instruments, calibrations, replaces] = await Promise.all([
    db.regulations.count(),
    db.arrays.count(),
    db.stations.count(),
    db.instruments.count(),
    db.calibrations.count(),
    db.replaces.count(),
  ]);
  return { regulations, arrays, stations, instruments, calibrations, replaces };
}

/** 写入结构版本号到 localStorage，便于几何页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION));
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso);
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function readLastArrayId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastArrayId);
  } catch {
    return null;
  }
}

export function writeLastArrayId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastArrayId);
    else localStorage.setItem(LS_KEYS.lastArrayId, id);
  } catch {
    // 忽略
  }
}
