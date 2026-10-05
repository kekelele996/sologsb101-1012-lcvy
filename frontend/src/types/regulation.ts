/**
 * 检定规程（计量站维护）与规程对账领域模型。
 *
 * 职责边界：
 * - 计量站：维护检定规程（规程号、版次、生效起止、各仪器类型的灵敏度区间与自噪上限）；
 * - 台网中心：只维护标定记录，按「标定当天生效的规程版本」判响应结论，不持有区间常量。
 *
 * 同一规程号（regulationCode）可有多个版次（edition），同一规程号同一生效日最多一版生效。
 */
import type { InstrumentType } from '@/types/instrument';

/** 规程状态：生效中 / 已作废（换版后旧版自动置为作废） */
export type RegulationStatus = '生效中' | '已作废';

export const REGULATION_STATUSES: RegulationStatus[] = ['生效中', '已作废'];

/** 单类型判据：灵敏度闭区间 + 自噪上限 */
export interface TypeCriterion {
  /** 灵敏度下限（V·s/m，含） */
  sensitivityMin: number;
  /** 灵敏度上限（V·s/m，含） */
  sensitivityMax: number;
  /** 自噪上限（含） */
  selfNoiseLimit: number;
}

/** 检定规程：一个规程号的一版 */
export interface VerificationRegulation {
  id: string;
  /** 规程号，如 JJG 860-2015；同规程号换版不变 */
  regulationCode: string;
  /** 版次，如 2015 版 / 2024 版，与规程号共同唯一 */
  edition: string;
  /** 规程正式名称 */
  name: string;
  /** 发布 / 归口单位（计量站口径） */
  issuer: string;
  /** 生效起始日（YYYY-MM-DD，含） */
  effectiveFrom: string;
  /** 生效截止日（YYYY-MM-DD，含；null 表示长期有效） */
  effectiveTo: string | null;
  /** 生效中 / 已作废 */
  status: RegulationStatus;
  /** 各仪器类型判据；缺类型即该版未覆盖该类型 */
  criteria: Partial<Record<InstrumentType, TypeCriterion>>;
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 标定与规程的绑定状态 */
export type CalibrationBindStatus =
  | 'bound' // 已绑定某版规程（无论是否已出结论）
  | 'pendingRejudge' // 规程换版/作废，尚未出结论，挂起等待按新版重判
  | 'readonlyMismatch'; // 对不上账（无规程号 / 当天无生效版），只读保留

/** 出结论时固化的判据快照，保证「出过结论的照旧保留、写清依据哪版」 */
export interface VerdictBasis {
  regulationId: string;
  regulationCode: string;
  edition: string;
  /** 判据模式：on-date 按标定当天生效版；current 换版后按现行版重判 */
  mode: 'on-date' | 'current';
  /** 判定时使用的该类型区间与自噪上限 */
  criterion: TypeCriterion;
  /** 判定时间戳 */
  judgedAt: number;
}

/* ------------------------------ 查询与判定 ------------------------------ */

/** 日期字符串比较：a <= b（b 为 null 视为无限远） */
export function dateWithin(date: string, from: string, to: string | null): boolean {
  if (date < from) return false;
  if (to !== null && date > to) return false;
  return true;
}

/** 该版在指定日期是否处于生效窗口（不看 status 字段，纯粹按日期） */
export function isEffectiveOn(regulation: VerificationRegulation, date: string): boolean {
  return dateWithin(date, regulation.effectiveFrom, regulation.effectiveTo);
}

/**
 * 按规程号 + 标定日期定位当天生效的版本。
 * 同一规程号当天有多版（数据异常）时取生效起始日最晚的一版。
 */
export function findEffectiveRegulation(
  regulations: VerificationRegulation[],
  regulationCode: string,
  date: string
): VerificationRegulation | null {
  const candidates = regulations
    .filter((item) => item.regulationCode === regulationCode && isEffectiveOn(item, date))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return candidates[0] ?? null;
}

/** 某规程号当前（指定参照日）生效中的版本：日期落在窗口且状态为「生效中」 */
export function findCurrentRegulation(
  regulations: VerificationRegulation[],
  regulationCode: string,
  today: string = new Date().toISOString().slice(0, 10)
): VerificationRegulation | null {
  const candidates = regulations
    .filter(
      (item) =>
        item.regulationCode === regulationCode &&
        item.status === '生效中' &&
        isEffectiveOn(item, today)
    )
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return candidates[0] ?? null;
}

/** 同一规程号在指定日期是否已有别的版本占用生效窗口（排除自身） */
export function findOverlappingRegulation(
  regulations: VerificationRegulation[],
  draft: Pick<VerificationRegulation, 'regulationCode' | 'effectiveFrom' | 'effectiveTo'> & { id?: string },
): VerificationRegulation | null {
  const from = draft.effectiveFrom;
  const to = draft.effectiveTo;
  const overlap = regulations.find((item) => {
    if (item.regulationCode !== draft.regulationCode) return false;
    if (draft.id && item.id === draft.id) return false;
    // 区间相交判定：item.from <= to 且 from <= item.to（null 端按无限远）
    if (to !== null && item.effectiveFrom > to) return false;
    if (item.effectiveTo !== null && from > item.effectiveTo) return false;
    return true;
  });
  return overlap ?? null;
}

/** 取某版对某仪器类型的判据 */
export function criterionOf(
  regulation: VerificationRegulation | null | undefined,
  type: string
): TypeCriterion | null {
  if (!regulation) return null;
  return regulation.criteria[type as InstrumentType] ?? null;
}

export interface JudgeResult {
  verdict: '合格' | '不合格';
  /** 越限的具体原因 */
  reasons: string[];
}

/** 按给定判据判定；数值非法或类型未覆盖时抛错（由调用方决定挂起策略） */
export function judgeWithCriterion(
  criterion: TypeCriterion,
  sensitivity: number,
  selfNoise: number
): JudgeResult {
  if (!Number.isFinite(sensitivity) || !Number.isFinite(selfNoise)) {
    throw new Error('灵敏度或自噪不是有效数值，无法判定');
  }
  const reasons: string[] = [];
  if (sensitivity < criterion.sensitivityMin || sensitivity > criterion.sensitivityMax) {
    reasons.push(
      `灵敏度 ${sensitivity} 超出区间 ${criterion.sensitivityMin} ~ ${criterion.sensitivityMax}`
    );
  }
  if (selfNoise > criterion.selfNoiseLimit) {
    reasons.push(`自噪 ${selfNoise} 高于上限 ${criterion.selfNoiseLimit}`);
  }
  return { verdict: reasons.length > 0 ? '不合格' : '合格', reasons };
}

/* ------------------------------ 对账 ------------------------------ */

/** 对账单行结论 */
export type ReconcileStatus = 'matched' | 'note' | 'mismatch';

export interface ReconcileItem {
  status: ReconcileStatus;
  /** 不符项说明 */
  reason: string;
}

/**
 * 两边按规程号与标定日期对账。
 * - matched：记录引用的规程号存在、版次存在，且标定日期落在该版生效窗口；
 * - note：换版后按现行版重判出结论的（标定日期不在该版窗口，但有重判依据快照）；
 * - mismatch：无规程号 / 规程或版次缺失 / 日期对不上，单列只读。
 */
export function reconcileCalibration(
  calibration: {
    regulationCode?: string | null;
    regulationId?: string | null;
    date: string;
    bindStatus?: CalibrationBindStatus;
    verdictBasis?: VerdictBasis | null;
  },
  regulationsById: Map<string, VerificationRegulation>
): ReconcileItem {
  if (calibration.bindStatus === 'readonlyMismatch') {
    return { status: 'mismatch', reason: '旧数据回填失败，已按只读保留' };
  }
  const code = calibration.regulationCode ?? '';
  if (!code) {
    return { status: 'mismatch', reason: '标定记录未登记规程号' };
  }
  const regulation = calibration.regulationId
    ? regulationsById.get(calibration.regulationId)
    : undefined;
  if (!regulation) {
    return { status: 'mismatch', reason: `规程号 ${code} 在计量站规程库中查无此版` };
  }
  if (regulation.regulationCode !== code) {
    return {
      status: 'mismatch',
      reason: `记录规程号 ${code} 与所引版次（${regulation.regulationCode} ${regulation.edition}）不一致`,
    };
  }
  if (isEffectiveOn(regulation, calibration.date)) {
    return { status: 'matched', reason: '规程号、版次与标定日期一致' };
  }
  if (calibration.verdictBasis?.mode === 'current') {
    return {
      status: 'note',
      reason: `标定日不在 ${regulation.edition} 生效窗口内，系换版后按现行版重判`,
    };
  }
  return {
    status: 'mismatch',
    reason: `标定日期 ${calibration.date} 不在 ${code} ${regulation.edition} 生效期（${regulation.effectiveFrom} ~ ${regulation.effectiveTo ?? '至今'}）内`,
  };
}

/** 依据描述文案，用于标定列表 / 报告展示「依据哪版」 */
export function basisText(basis: VerdictBasis | null | undefined): string {
  if (!basis) return '未固化判据';
  return `${basis.regulationCode} ${basis.edition}${basis.mode === 'current' ? '（换版重判）' : ''}`;
}
