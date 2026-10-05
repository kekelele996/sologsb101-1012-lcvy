/**
 * 检定规程：计量站维护的响应结论判定依据。
 * 记规程号、生效起止与各类型灵敏度区间 / 自噪上限；
 * 台网中心按标定当天生效的规程定响应结论，同趟出车落在同版。
 */
import type { InstrumentType } from './instrument';
import type { ResponseVerdict } from './calibration';

/** 灵敏度合格区间（V·s/m）：下限 ~ 上限 */
export interface SensitivityRange {
  min: number;
  max: number;
}

/** 某仪器类型的检定限界 */
export interface RegulationTypeLimit {
  /** 灵敏度合格区间（V·s/m） */
  sensitivity: SensitivityRange;
  /** 自噪上限 */
  selfNoiseLimit: number;
}

/** 检定规程状态：现行 / 作废 */
export type RegulationStatus = '现行' | '作废';

export const REGULATION_STATUSES: RegulationStatus[] = ['现行', '作废'];

/** 检定规程：计量站维护的判定依据版本 */
export interface VerificationRegulation {
  id: string;
  /** 规程号，如 JJG 101-2018 */
  code: string;
  /** 规程名称 */
  name: string;
  /** 发布 / 计量机构 */
  agency: string;
  /** 生效起始日期（YYYY-MM-DD） */
  effectiveFrom: string;
  /** 生效截止日期，null 表示现行有效 */
  effectiveTo: string | null;
  /** 各仪器类型的灵敏度区间与自噪上限 */
  typeLimits: Record<InstrumentType, RegulationTypeLimit>;
  /** 状态：现行 / 作废 */
  status: RegulationStatus;
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 标定批次：同趟出车的仪器共用同一规程版本。
 * 批次日期决定规程版本，同批次标定记录共享同一规程号。
 */
export interface CalibrationBatch {
  id: string;
  /** 批次号 / 趟次，如 2024 春巡 */
  code: string;
  /** 出车 / 标定日期 */
  date: string;
  /** 依据的规程 id */
  regulationId: string;
  /** 依据的规程号 */
  regulationCode: string;
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 判定状态：已判定（出过结论）/ 待重判（没出结论，先挂着按新版重判） */
export type VerdictState = '已判定' | '待重判';

export const VERDICT_STATES: VerdictState[] = ['已判定', '待重判'];

/* ------------------------------ 默认规程版本 ------------------------------ */

/** 旧版规程（2018 版）：区间与自噪上限沿用台网常规口径 */
export const DEFAULT_REGULATION_OLD: VerificationRegulation = {
  id: 'reg_jjg101_2018',
  code: 'JJG 101-2018',
  name: '地震台站仪器检定规程（2018 版）',
  agency: '国家测震台网计量中心',
  effectiveFrom: '2018-01-01',
  effectiveTo: '2023-06-30',
  typeLimits: {
    宽频带: { sensitivity: { min: 800, max: 3000 }, selfNoiseLimit: 3.5 },
    短周期: { sensitivity: { min: 100, max: 800 }, selfNoiseLimit: 3.5 },
    强震: { sensitivity: { min: 0.1, max: 5 }, selfNoiseLimit: 3.5 },
  },
  status: '作废',
  remark: '2018 版规程，2023-07-01 起被 2023 版替代',
  createdAt: 0,
  updatedAt: 0,
};

/** 新版规程（2023 版）：计量站换版后的区间与自噪上限 */
export const DEFAULT_REGULATION_NEW: VerificationRegulation = {
  id: 'reg_jjg101_2023',
  code: 'JJG 101-2023',
  name: '地震台站仪器检定规程（2023 版）',
  agency: '国家测震台网计量中心',
  effectiveFrom: '2023-07-01',
  effectiveTo: null,
  typeLimits: {
    宽频带: { sensitivity: { min: 750, max: 3200 }, selfNoiseLimit: 3.0 },
    短周期: { sensitivity: { min: 90, max: 850 }, selfNoiseLimit: 3.0 },
    强震: { sensitivity: { min: 0.08, max: 5.5 }, selfNoiseLimit: 3.0 },
  },
  status: '现行',
  remark: '2023 版规程，灵敏度区间与自噪上限均有调整',
  createdAt: 0,
  updatedAt: 0,
};

/** 默认规程列表（按生效日期升序） */
export const DEFAULT_REGULATIONS: VerificationRegulation[] = [
  DEFAULT_REGULATION_OLD,
  DEFAULT_REGULATION_NEW,
];

/* ------------------------------ 规程判定工具 ------------------------------ */

/** 判断规程在指定日期是否有效（现行且在生效区间内） */
export function isRegulationEffective(reg: VerificationRegulation, date: string): boolean {
  if (reg.status === '作废') return false;
  if (!date || date < reg.effectiveFrom) return false;
  if (reg.effectiveTo && date > reg.effectiveTo) return false;
  return true;
}

/** 查找指定日期生效的规程（取生效起始最晚的一个，避免区间重叠歧义） */
export function findEffectiveRegulation(
  regs: VerificationRegulation[],
  date: string
): VerificationRegulation | null {
  if (!date) return null;
  const candidates = regs.filter((reg) => isRegulationEffective(reg, date));
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a.effectiveFrom >= b.effectiveFrom ? a : b));
}

/** 按规程判定响应结论：灵敏度落在区间内且自噪不高于上限判合格 */
export function judgeByRegulation(
  reg: VerificationRegulation,
  type: InstrumentType,
  sensitivity: number,
  selfNoise: number
): ResponseVerdict {
  if (!Number.isFinite(sensitivity) || !Number.isFinite(selfNoise)) return '待判定';
  const limit = reg.typeLimits[type];
  if (!limit) return '待判定';
  if (sensitivity < limit.sensitivity.min || sensitivity > limit.sensitivity.max) return '不合格';
  if (selfNoise > limit.selfNoiseLimit) return '不合格';
  return '合格';
}

/** 判定结果：结论 + 是否出了结论 */
export interface JudgeOutcome {
  verdict: ResponseVerdict;
  verdictState: VerdictState;
}

/** 按规程判定并返回判定状态（出结论 / 待重判） */
export function judgeWithState(
  reg: VerificationRegulation | null,
  type: InstrumentType,
  sensitivity: number,
  selfNoise: number
): JudgeOutcome {
  if (!reg) return { verdict: '待判定', verdictState: '待重判' };
  const verdict = judgeByRegulation(reg, type, sensitivity, selfNoise);
  return {
    verdict,
    verdictState: verdict === '待判定' ? '待重判' : '已判定',
  };
}

/* ------------------------------ 对账工具 ------------------------------ */

/** 对账状态：一致 / 不一致 / 无规程 / 未记录 */
export type ReconcileStatus = '一致' | '不一致' | '无规程' | '未记录';

export const RECONCILE_STATUSES: ReconcileStatus[] = ['一致', '不一致', '无规程', '未记录'];

/** 对账条目：台网中心记录的规程号 vs 计量站按日期对应的规程号 */
export interface ReconciliationItem {
  calibrationId: string;
  instrumentId: string;
  calibrationDate: string;
  /** 台网中心记录的规程号 */
  recordedRegulationCode: string;
  /** 计量站按标定日期对应的规程号 */
  effectiveRegulationCode: string | null;
  /** 计量站按标定日期对应的规程 id */
  effectiveRegulationId: string | null;
  status: ReconcileStatus;
  verdict: ResponseVerdict;
  verdictState: VerdictState;
}

/** 对账：逐条比对标定记录的规程号与按日期对应的规程号 */
export function reconcileCalibrations(
  calibrations: Array<{
    id: string;
    instrumentId: string;
    date: string;
    regulationCode: string;
    responseVerdict: ResponseVerdict;
    verdictState: VerdictState;
  }>,
  regulations: VerificationRegulation[]
): ReconciliationItem[] {
  return calibrations.map((cal) => {
    const effective = findEffectiveRegulation(regulations, cal.date);
    const recorded = cal.regulationCode?.trim() ?? '';
    let status: ReconcileStatus;
    if (!recorded) {
      status = '未记录';
    } else if (!effective) {
      status = '无规程';
    } else if (recorded === effective.code) {
      status = '一致';
    } else {
      status = '不一致';
    }
    return {
      calibrationId: cal.id,
      instrumentId: cal.instrumentId,
      calibrationDate: cal.date,
      recordedRegulationCode: recorded,
      effectiveRegulationCode: effective?.code ?? null,
      effectiveRegulationId: effective?.id ?? null,
      status,
      verdict: cal.responseVerdict,
      verdictState: cal.verdictState,
    };
  });
}
