/**
 * 标定—规程绑定与响应结论判定服务（台网中心侧）。
 *
 * 规则：
 * - 同趟（tripNo）标定落在同一版规程：趟次内任一条解析到的生效版本即全组版本；
 * - 按标定当天生效的规程版本取类型判据判定，出结论即固化判据快照；
 * - 规程换版 / 作废后：未出结论的置「待重判」挂起，可按现行版重判；
 *   已出结论的保留原结论与依据；
 * - 重判失败只回写本方标定（judgeError），不改规程；
 * - 解析不到规程 / 类型判据缺失 → 对不上账，只读保留。
 */
import type { Calibration, ResponseVerdict } from '@/types/calibration';
import type { InstrumentType } from '@/types/instrument';
import {
  criterionOf,
  findCurrentRegulation,
  findEffectiveRegulation,
  judgeWithCriterion,
  type CalibrationBindStatus,
  type TypeCriterion,
  type VerificationRegulation,
  type VerdictBasis,
} from '@/types/regulation';

/** 一次绑定解析的结果 */
export interface BindingResolution {
  status: CalibrationBindStatus;
  regulation: VerificationRegulation | null;
  /** 不符 / 挂起原因 */
  reason: string;
}

/**
 * 按规程号（缺省由趟次日期在全部规程中唯一定位）与标定日期解析当天生效版。
 */
export function resolveBinding(
  regulations: VerificationRegulation[],
  params: { date: string; regulationCode?: string | null }
): BindingResolution {
  const code = params.regulationCode?.trim() ?? '';
  if (!code) {
    return { status: 'readonlyMismatch', regulation: null, reason: '未登记规程号' };
  }
  const regulation = findEffectiveRegulation(regulations, code, params.date);
  if (!regulation) {
    const exists = regulations.some((item) => item.regulationCode === code);
    return {
      status: 'readonlyMismatch',
      regulation: null,
      reason: exists
        ? `规程号 ${code} 在 ${params.date} 无生效版本`
        : `规程号 ${code} 在规程库中不存在`,
    };
  }
  if (regulation.status === '已作废') {
    // 历史标定依据旧版仍属正常；只有待判定记录才会在换版时挂起
    return { status: 'bound', regulation, reason: '' };
  }
  return { status: 'bound', regulation, reason: '' };
}

/** 对一组同趟标定统一绑定：按趟次日期解析，全组共用一版 */
export function resolveTripBinding(
  regulations: VerificationRegulation[],
  trip: { date: string; regulationCode?: string | null }
): BindingResolution {
  return resolveBinding(regulations, { date: trip.date, regulationCode: trip.regulationCode });
}

/** 生成趟次号：PC + 日期 + 可选站点 / 出车序号 */
export function makeTripNo(date: string, tag = ''): string {
  const compact = date.replace(/-/g, '');
  return tag ? `PC${compact}-${tag}` : `PC${compact}`;
}

export interface JudgeInput {
  type: string;
  sensitivity: number;
  selfNoise: number;
}

export interface JudgeOutcome {
  verdict: ResponseVerdict;
  basis: VerdictBasis | null;
  error: string;
}

/**
 * 按指定规程判定单条标定并生成判据快照。
 * mode=on-date 表示按标定当天生效版；current 表示换版后按现行版重判。
 */
export function judgeAgainst(
  regulation: VerificationRegulation,
  input: JudgeInput,
  mode: VerdictBasis['mode']
): JudgeOutcome {
  const criterion: TypeCriterion | null = criterionOf(regulation, input.type as InstrumentType);
  if (!criterion) {
    return {
      verdict: '待判定',
      basis: null,
      error: `${regulation.regulationCode} ${regulation.edition} 未覆盖仪器类型「${input.type}」`,
    };
  }
  try {
    const result = judgeWithCriterion(criterion, input.sensitivity, input.selfNoise);
    return {
      verdict: result.verdict,
      basis: {
        regulationId: regulation.id,
        regulationCode: regulation.regulationCode,
        edition: regulation.edition,
        mode,
        criterion: { ...criterion },
        judgedAt: Date.now(),
      },
      error: '',
    };
  } catch (error) {
    return {
      verdict: '待判定',
      basis: null,
      error: error instanceof Error ? error.message : '判定失败',
    };
  }
}

/**
 * 换版 / 作废后处理一批标定：
 * - 已出结论（verdictBasis 非空）的一律照旧保留；
 * - 未出结论且引用的规程正是被替换 / 作废版本的，挂「待重判」。
 * 返回被挂起的标定 id。
 */
export function markPendingAfterRegulationChange(
  affectedRegulationIds: Set<string>
): (calibration: Calibration) => boolean {
  return (calibration) => {
    if (calibration.verdictBasis) return false;
    if (calibration.bindStatus === 'readonlyMismatch') return false;
    return !!calibration.regulationId && affectedRegulationIds.has(calibration.regulationId);
  };
}

/**
 * 对单条「待重判」标定按同规程号现行版重判。
 * - 找到生效中的现行版并判得出结论：bindStatus=bound、写结论与快照（mode=current）、清错误；
 * - 无「生效中」版本（规程作废后尚未发新版）：保持待重判，错误记在本方标定上，规程不动；
 * - 类型未覆盖 / 数值非法：保持待重判并记录错误。
 */
export function rejudgeAgainstCurrent(
  calibration: Calibration,
  instrumentType: string,
  regulations: VerificationRegulation[],
  today: string = new Date().toISOString().slice(0, 10)
): Pick<Calibration, 'responseVerdict' | 'verdictBasis' | 'judgeError' | 'bindStatus' | 'regulationId' | 'regulationCode' | 'updatedAt'> {
  const code = calibration.regulationCode;
  const current = findCurrentRegulation(regulations, code, today);
  if (!current) {
    return {
      responseVerdict: '待判定',
      verdictBasis: null,
      bindStatus: 'pendingRejudge',
      regulationId: calibration.regulationId,
      regulationCode: code,
      judgeError: `规程号 ${code} 当前无生效版本，保留挂起，规程未改动`,
      updatedAt: Date.now(),
    };
  }
  const outcome = judgeAgainst(
    current,
    { type: instrumentType, sensitivity: calibration.sensitivity, selfNoise: calibration.selfNoise },
    'current'
  );
  if (outcome.verdict === '待判定' || !outcome.basis) {
    return {
      responseVerdict: '待判定',
      verdictBasis: null,
      bindStatus: 'pendingRejudge',
      regulationId: current.id,
      regulationCode: code,
      judgeError: outcome.error || '重判未得出结论',
      updatedAt: Date.now(),
    };
  }
  return {
    responseVerdict: outcome.verdict,
    verdictBasis: outcome.basis,
    bindStatus: 'bound',
    regulationId: current.id,
    regulationCode: code,
    judgeError: '',
    updatedAt: Date.now(),
  };
}

/**
 * 旧数据升级（v2 → v3）回填辅助：给定历史标定的日期与机构，
 * 在规程库中按日期匹配当时生效版本；对不上返回只读绑定。
 */
export function backfillLegacyBinding(
  regulations: VerificationRegulation[],
  legacy: { date: string }
): {
  regulationId: string | null;
  regulationCode: string;
  bindStatus: CalibrationBindStatus;
} {
  // 旧数据没记规程号：演示口径只有一套地震观测仪器检定规程，按日期唯一定位
  const onDate = regulations
    .filter((item) => item.effectiveFrom <= legacy.date && (item.effectiveTo === null || item.effectiveTo >= legacy.date))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  if (!onDate) {
    return { regulationId: null, regulationCode: '', bindStatus: 'readonlyMismatch' };
  }
  return {
    regulationId: onDate.id,
    regulationCode: onDate.regulationCode,
    bindStatus: 'bound',
  };
}

/** 一条标定是否只读（对账不符的旧数据） */
export function isReadonlyCalibration(calibration: Calibration): boolean {
  return calibration.bindStatus === 'readonlyMismatch';
}
