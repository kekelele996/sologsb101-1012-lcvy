/**
 * 检定规程 slice（计量站侧）：
 * 维护规程版本（规程号、版次、生效起止、各类型灵敏度区间与自噪上限），
 * 换版时把旧版置为作废，并把引用旧版且「未出结论」的标定挂起为待重判。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type {
  VerificationRegulation,
  RegulationStatus,
  TypeCriterion,
} from '@/types/regulation';
import type { Calibration } from '@/types/calibration';
import type { InstrumentType } from '@/types/instrument';

export interface RegulationDraft {
  regulationCode: string;
  edition: string;
  name: string;
  issuer: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  criteria: Partial<Record<InstrumentType, TypeCriterion>>;
  remark: string;
}

export interface RegulationSliceState {
  regulations: VerificationRegulation[];
  ready: boolean;
  error: string | null;
  lastReceipt: string;
}

const initialState: RegulationSliceState = {
  regulations: [],
  ready: false,
  error: null,
  lastReceipt: '',
};

/**
 * 换版：把同规程号、生效窗口与新版相交的旧版置为作废，
 * 截止日收到新版生效前一天；新版生效日之后仍在窗口内的版本同样作废。
 */
async function supersedeOldEditions(next: VerificationRegulation): Promise<string[]> {
  const supersededIds: string[] = [];
  const now = Date.now();
  await db.regulations
    .where('regulationCode')
    .equals(next.regulationCode)
    .modify((row: VerificationRegulation) => {
      if (row.id === next.id) return;
      const intersects =
        row.effectiveFrom < next.effectiveFrom &&
        (row.effectiveTo === null || row.effectiveTo >= next.effectiveFrom);
      const continues = row.effectiveFrom >= next.effectiveFrom;
      if (intersects) {
        row.status = '已作废';
        const dayBefore = new Date(Date.parse(`${next.effectiveFrom}T00:00:00`) - 86400000)
          .toISOString()
          .slice(0, 10);
        row.effectiveTo = dayBefore;
        row.updatedAt = now;
        supersededIds.push(row.id);
      } else if (continues) {
        row.status = '已作废';
        row.updatedAt = now;
        supersededIds.push(row.id);
      }
    });
  return supersededIds;
}

/** 新建规程版本；同一规程号旧版自动换版作废，待判定标定挂起 */
export const createRegulation = createAsyncThunk(
  'regulation/createRegulation',
  async (draft: RegulationDraft, { rejectWithValue }) => {
    const code = draft.regulationCode.trim();
    if (!code) return rejectWithValue('请填写规程号');
    if (!draft.edition.trim()) return rejectWithValue('请填写版次');
    const existing = await db.regulations.toArray();
    const duplicate = existing.find(
      (item) => item.regulationCode === code && item.edition === draft.edition.trim()
    );
    if (duplicate) return rejectWithValue(`规程号 ${code} 的 ${draft.edition} 已存在，不能重复登记`);
    const now = Date.now();
    const row: VerificationRegulation = {
      id: createId('reg'),
      regulationCode: code,
      edition: draft.edition.trim(),
      name: draft.name.trim(),
      issuer: draft.issuer.trim(),
      effectiveFrom: draft.effectiveFrom,
      effectiveTo: draft.effectiveTo,
      status: '生效中',
      criteria: draft.criteria,
      remark: draft.remark?.trim() ?? '',
      createdAt: now,
      updatedAt: now,
    };
    let pendingCount = 0;
    await db.transaction('rw', [db.regulations, db.calibrations], async () => {
      await db.regulations.put(row);
      const supersededIds = await supersedeOldEditions(row);
      if (supersededIds.length > 0) {
        const affected = new Set(supersededIds);
        await db.calibrations.toCollection().modify((calibration: Calibration) => {
          if (calibration.verdictBasis) return; // 出过结论的照旧保留
          if (calibration.bindStatus === 'readonlyMismatch') return;
          if (calibration.regulationId && affected.has(calibration.regulationId)) {
            calibration.bindStatus = 'pendingRejudge';
            calibration.judgeError = '所依据规程已换版，等待按现行版重判';
            calibration.updatedAt = now;
            pendingCount += 1;
          }
        });
      }
    });
    return { row, pendingCount };
  }
);

/** 编辑规程：未被引用的版本可改全部字段；已被标定引用的只准改名称/归口/备注；作废联动挂起 */
export const updateRegulation = createAsyncThunk(
  'regulation/updateRegulation',
  async (
    payload: { id: string; patch: Partial<RegulationDraft>; status?: RegulationStatus },
    { rejectWithValue }
  ) => {
    const existing = await db.regulations.get(payload.id);
    if (!existing) return rejectWithValue('规程版本不存在');
    const referenced = await db.calibrations
      .where('regulationId')
      .equals(payload.id)
      .count();
    const now = Date.now();
    const voiding = payload.status === '已作废' && existing.status !== '已作废';

    await db.transaction('rw', [db.regulations, db.calibrations], async () => {
      if (referenced > 0) {
        // 判据与生效区间冻结：换参数必须发新版
        await db.regulations.update(payload.id, {
          name: payload.patch.name?.trim() ?? existing.name,
          issuer: payload.patch.issuer?.trim() ?? existing.issuer,
          remark: payload.patch.remark ?? existing.remark,
          status: payload.status ?? existing.status,
          updatedAt: now,
        } as never);
      } else {
        await db.regulations.update(payload.id, {
          ...payload.patch,
          status: payload.status ?? existing.status,
          updatedAt: now,
        } as never);
      }
      if (voiding) {
        // 规程作废：未出结论的引用标定挂起，已出结论的照旧保留
        await db.calibrations.toCollection().modify((calibration: Calibration) => {
          if (calibration.verdictBasis) return;
          if (calibration.bindStatus === 'readonlyMismatch') return;
          if (calibration.regulationId === payload.id) {
            calibration.bindStatus = 'pendingRejudge';
            calibration.judgeError = '所依据规程已作废，等待同规程号新版重判';
            calibration.updatedAt = now;
          }
        });
      }
    });
    return { id: payload.id, frozen: referenced > 0, voided: voiding };
  }
);

const regulationSlice = createSlice({
  name: 'regulation',
  initialState,
  reducers: {
    setRegulations(state, action: PayloadAction<VerificationRegulation[]>) {
      state.regulations = action.payload;
      state.ready = true;
      state.error = null;
    },
    setRegulationError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setRegulationReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createRegulation.fulfilled, (state, action) => {
        state.lastReceipt =
          action.payload.pendingCount > 0
            ? `规程 ${action.payload.row.regulationCode} ${action.payload.row.edition} 已生效，旧版已作废，${action.payload.pendingCount} 条未出结论标定挂起重判`
            : `规程 ${action.payload.row.regulationCode} ${action.payload.row.edition} 已登记生效`;
      })
      .addCase(createRegulation.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '规程保存失败';
      })
      .addCase(updateRegulation.fulfilled, (state, action) => {
        state.lastReceipt = action.payload.voided
          ? '规程已作废，引用该版且未出结论的标定已挂起按新版重判；已出结论的照旧保留'
          : action.payload.frozen
            ? '该版已被标定记录引用，判据与生效区间冻结，仅更新名称/归口/备注；调整限值请发布新版'
            : '规程版本已更新';
      })
      .addCase(updateRegulation.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '规程更新失败';
      });
  },
});

export const { setRegulations, setRegulationError, setRegulationReceipt } = regulationSlice.actions;

let started = false;

/** 启动规程表实时订阅（幂等） */
export function startRegulationSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<VerificationRegulation>(() => db.regulations).subscribe((rows) => {
    dispatch(setRegulations(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectRegulations = (state: { regulation: RegulationSliceState }) =>
  state.regulation.regulations;
export const selectRegulationReady = (state: { regulation: RegulationSliceState }) =>
  state.regulation.ready;
export const selectRegulationError = (state: { regulation: RegulationSliceState }) =>
  state.regulation.error;
export const selectRegulationReceipt = (state: { regulation: RegulationSliceState }) =>
  state.regulation.lastReceipt;

export default regulationSlice.reducer;
