/**
 * 标定记录（台网中心维护）。
 *
 * 响应结论不再由写死的类型区间判定，而是：
 * 1. 按「趟次号（tripNo）」把同一次出车的多台仪器归为一组，同趟绑定同一版规程；
 * 2. 按标定当天生效的检定规程版本取该仪器类型的区间与自噪上限判定；
 * 3. 出结论时固化判据快照（VerdictBasis），规程换版或作废后已出结论照旧保留。
 */
import type { CalibrationBindStatus, VerdictBasis } from '@/types/regulation';

/** 响应结论 */
export type ResponseVerdict = '合格' | '不合格' | '待判定';

export const RESPONSE_VERDICTS: ResponseVerdict[] = ['合格', '不合格', '待判定'];

/** 标定：同一仪器可叠加多次标定记录 */
export interface Calibration {
  id: string;
  /** 被标定仪器 */
  instrumentId: string;
  /** 标定日期 */
  date: string;
  /**
   * 趟次号：同一次出车标定的多台仪器共用一个趟次号，
   * 全组绑定标定当天生效的同一版规程（如 PC20240930-HX01）。
   */
  tripNo: string;
  /** 灵敏度（V·s/m） */
  sensitivity: number;
  /** 自噪（m/s² 或 counts，按台网口径记录） */
  selfNoise: number;
  /** 脉冲响应结论 */
  responseVerdict: ResponseVerdict;
  /** 绑定的规程 id（对不上账时可为空并只读保留） */
  regulationId: string | null;
  /** 冗余记录规程号，用于两边对账 */
  regulationCode: string;
  /** 绑定状态：已绑定 / 待重判 / 对账不符只读 */
  bindStatus: CalibrationBindStatus;
  /** 已出结论的判据快照；待判定 / 待重判时为 null */
  verdictBasis: VerdictBasis | null;
  /** 最近一次重判失败原因（仅挂在本方标定上，不动规程） */
  judgeError: string;
  /** 标定人 */
  operator: string;
  /** 标定机构 */
  agency: string;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 灵敏度变化量（相对上一次标定），返回绝对值与百分比 */
export interface SensitivityDelta {
  /** 本次 - 上次 */
  absolute: number;
  /** 变化百分比（%） */
  percent: number;
  /** 是否有上一次标定可比 */
  comparable: boolean;
}

export function sensitivityDelta(current: number, previous: number | null): SensitivityDelta {
  if (previous === null || !Number.isFinite(previous) || previous === 0) {
    return { absolute: 0, percent: 0, comparable: false };
  }
  const absolute = Number((current - previous).toFixed(2));
  return { absolute, percent: Number(((absolute / previous) * 100).toFixed(2)), comparable: true };
}

/** 标定页筛选条件（存于 calibrationSlice） */
export interface CalibrationFilterState {
  keyword: string;
  verdicts: ResponseVerdict[];
  instrumentTypes: string[];
  /** 是否只看超期未标定仪器 */
  onlyOverdue: boolean;
}

export function createEmptyCalibrationFilter(): CalibrationFilterState {
  return {
    keyword: '',
    verdicts: [],
    instrumentTypes: [],
    onlyOverdue: false
  };
}

/** 待标定天数文案：正数为剩余天数、负数为超期天数、0 为今日到期 */
export function calibrateDueText(dueInDays: number): string {
  if (!Number.isFinite(dueInDays)) return '标定日期缺失';
  if (dueInDays === 0) return '今日到期';
  if (dueInDays > 0) return `距下次标定 ${dueInDays} 天`;
  return `已超期 ${Math.abs(dueInDays)} 天`;
}
