/**
 * 检定规程 slice：计量站维护检定规程（规程号、生效起止、类型区间）与标定批次；
 * 规程换版或作废后，没出结论的标定先挂着按新版重判，出过结论的照旧保留并写清依据哪版。
 * 数据经 utils/db.ts 的 Dexie liveQuery 订阅后写入 store；页面只读 selector，写操作落 IndexedDB。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type { RootState } from '@/stores/store';
import type { Calibration } from '@/types/calibration';
import type { InstrumentType } from '@/types/instrument';
import type {
  CalibrationBatch,
  RegulationStatus,
  VerificationRegulation,
  VerdictState,
} from '@/types/regulation';
import {
  DEFAULT_REGULATIONS,
  findEffectiveRegulation,
  judgeByRegulation,
  reconcileCalibrations,
  type ReconciliationItem,
} from '@/types/regulation';

/** 选择器入参统一用 RootState */
type WithRegulation = RootState;

export interface RegulationSliceState {
  regulations: VerificationRegulation[];
  batches: CalibrationBatch[];
  ready: boolean;
  error: string | null;
  /** 最近一次操作回执 */
  lastReceipt: string;
}

const initialState: RegulationSliceState = {
  regulations: [],
  batches: [],
  ready: false,
  error: null,
  lastReceipt: '',
};

/* ------------------------------ 检定规程 CRUD ------------------------------ */

export const createRegulation = createAsyncThunk(
  'regulation/createRegulation',
  async (payload: Omit<VerificationRegulation, 'id' | 'createdAt' | 'updatedAt'>) => {
    const now = Date.now();
    const row: VerificationRegulation = {
      ...payload,
      id: createId('reg'),
      createdAt: now,
      updatedAt: now,
    };
    await db.regulations.put(row);
    return row;
  }
);

export const updateRegulation = createAsyncThunk(
  'regulation/updateRegulation',
  async (payload: { id: string; patch: Partial<VerificationRegulation> }) => {
    await db.regulations.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

/** 作废规程：置为作废并截止生效日期，触发待重判标定按新版重判 */
export const invalidateRegulation = createAsyncThunk(
  'regulation/invalidateRegulation',
  async (payload: { id: string; effectiveTo: string }, { dispatch }) => {
    const now = Date.now();
    await db.regulations.update(
      payload.id,
      { status: '作废', effectiveTo: payload.effectiveTo, updatedAt: now } as never
    );
    // 规程作废后，没出结论的先挂着按新版重判
    await dispatch(rejudgePending());
    return payload;
  }
);

export const removeRegulation = createAsyncThunk(
  'regulation/removeRegulation',
  async (regulationId: string) => {
    await db.regulations.delete(regulationId);
    return regulationId;
  }
);

/* ------------------------------ 标定批次 CRUD ------------------------------ */

export const createBatch = createAsyncThunk(
  'regulation/createBatch',
  async (payload: Omit<CalibrationBatch, 'id' | 'createdAt' | 'updatedAt' | 'regulationId' | 'regulationCode'>) => {
    const now = Date.now();
    const regulations = await db.regulations.toArray();
    const effective = findEffectiveRegulation(regulations, payload.date);
    const row: CalibrationBatch = {
      ...payload,
      id: createId('bat'),
      regulationId: effective?.id ?? '',
      regulationCode: effective?.code ?? '',
      createdAt: now,
      updatedAt: now,
    };
    await db.calibrationBatches.put(row);
    return row;
  }
);

export const updateBatch = createAsyncThunk(
  'regulation/updateBatch',
  async (payload: { id: string; patch: Partial<CalibrationBatch> }) => {
    // 批次日期变更后重新确定规程版本
    if (payload.patch.date) {
      const regulations = await db.regulations.toArray();
      const effective = findEffectiveRegulation(regulations, payload.patch.date);
      payload.patch.regulationId = effective?.id ?? '';
      payload.patch.regulationCode = effective?.code ?? '';
    }
    await db.calibrationBatches.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

export const removeBatch = createAsyncThunk('regulation/removeBatch', async (batchId: string) => {
  await db.calibrationBatches.delete(batchId);
  return batchId;
});

/* ------------------------------ 重判 ------------------------------ */

/**
 * 重判待重判标定：规程换版或作废后，没出结论的先挂着按新版重判。
 * 只重判本方标定记录，规程不动；出过结论的照旧保留。
 */
export const rejudgePending = createAsyncThunk(
  'regulation/rejudgePending',
  async (_, { getState }) => {
    const state = getState() as RootState;
    const regulations = state.regulation.regulations;
    const instruments = state.instrument.instruments;

    // 直接从 DB 读取，避免 store 数据滞后
    const allCalibrations = await db.calibrations.toArray();
    const pending = allCalibrations.filter((cal) => cal.verdictState === '待重判');
    const now = Date.now();
    let rejudged = 0;

    await db.transaction('rw', [db.calibrations], async () => {
      for (const cal of pending) {
        const instrument = instruments.find((ins) => ins.id === cal.instrumentId);
        const effective = findEffectiveRegulation(regulations, cal.date);
        if (!effective || !instrument) continue;
        const verdict = judgeByRegulation(
          effective,
          instrument.type as InstrumentType,
          cal.sensitivity,
          cal.selfNoise
        );
        await db.calibrations.update(cal.id, {
          responseVerdict: verdict,
          regulationId: effective.id,
          regulationCode: effective.code,
          verdictState: verdict === '待判定' ? '待重判' : '已判定',
          updatedAt: now,
        } as never);
        rejudged += 1;
      }
    });

    return { total: pending.length, rejudged };
  }
);

/**
 * 重判单条标定：对账对不上时重试本方标定，规程不动。
 * 按标定日期对应的规程重新判定，更新结论与依据规程号。
 */
export const rejudgeCalibration = createAsyncThunk(
  'regulation/rejudgeCalibration',
  async (calibrationId: string, { getState }) => {
    const state = getState() as RootState;
    const instruments = state.instrument.instruments;

    // 直接从 DB 读取，避免 store 数据滞后
    const cal = await db.calibrations.get(calibrationId);
    if (!cal) return { calibrationId, rejudged: false };
    const instrument = instruments.find((ins) => ins.id === cal.instrumentId);
    const regulations = await db.regulations.toArray();
    const effective = findEffectiveRegulation(regulations, cal.date);
    if (!effective || !instrument) return { calibrationId, rejudged: false };

    const now = Date.now();
    const verdict = judgeByRegulation(
      effective,
      instrument.type as InstrumentType,
      cal.sensitivity,
      cal.selfNoise
    );
    await db.calibrations.update(calibrationId, {
      responseVerdict: verdict,
      regulationId: effective.id,
      regulationCode: effective.code,
      verdictState: verdict === '待判定' ? '待重判' : '已判定',
      updatedAt: now,
    } as never);
    return { calibrationId, rejudged: true, verdict };
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
    setBatches(state, action: PayloadAction<CalibrationBatch[]>) {
      state.batches = action.payload;
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
        state.lastReceipt = `检定规程「${action.payload.code}」已录入，生效起始 ${action.payload.effectiveFrom}`;
      })
      .addCase(invalidateRegulation.fulfilled, (state) => {
        state.lastReceipt = '规程已作废，待重判标定已按新版重判';
      })
      .addCase(rejudgePending.fulfilled, (state, action) => {
        state.lastReceipt = `待重判标定 ${action.payload.total} 条，已按新版重判 ${action.payload.rejudged} 条`;
      })
      .addCase(rejudgeCalibration.fulfilled, (state, action) => {
        state.lastReceipt = action.payload.rejudged
          ? `标定已按 ${action.payload.verdict ?? ''} 重判`
          : '重判失败：标定日期无生效规程，只读保留';
      });
  },
});

export const { setRegulations, setBatches, setRegulationError, setRegulationReceipt } =
  regulationSlice.actions;

let started = false;

/** 启动检定规程与标定批次表实时订阅（幂等） */
export function startRegulationSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<VerificationRegulation>(() => db.regulations).subscribe((rows) => {
    dispatch(setRegulations(rows));
  });
  watchTable<CalibrationBatch>(() => db.calibrationBatches).subscribe((rows) => {
    dispatch(setBatches(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectRegulationState = (state: WithRegulation): RegulationSliceState =>
  state.regulation;
export const selectRegulations = (state: WithRegulation): VerificationRegulation[] =>
  state.regulation.regulations;
export const selectBatches = (state: WithRegulation): CalibrationBatch[] => state.regulation.batches;
export const selectRegulationReady = (state: WithRegulation): boolean => state.regulation.ready;
export const selectRegulationReceipt = (state: WithRegulation): string =>
  state.regulation.lastReceipt;

/** 现行规程（生效截止为空或状态为现行） */
export const selectCurrentRegulations = (state: WithRegulation): VerificationRegulation[] =>
  state.regulation.regulations.filter((reg) => reg.status === '现行');

/** 按规程号查找规程 */
export const selectRegulationByCode = (
  state: WithRegulation,
  code: string | null | undefined
): VerificationRegulation | null =>
  code ? state.regulation.regulations.find((reg) => reg.code === code) ?? null : null;

/** 对账条目：逐条比对标定记录的规程号与按日期对应的规程号 */
export const selectReconciliation = (state: WithRegulation): ReconciliationItem[] => {
  const calibrations = state.calibration.calibrations;
  const regulations = state.regulation.regulations;
  return reconcileCalibrations(calibrations, regulations);
};

/** 对不上的对账条目（单列） */
export const selectReconciliationMismatches = (state: WithRegulation): ReconciliationItem[] =>
  selectReconciliation(state).filter((item) => item.status !== '一致');

/** 待重判标定数 */
export const selectPendingRejudgeCount = (state: WithRegulation): number =>
  state.calibration.calibrations.filter((cal) => cal.verdictState === '待重判').length;

export default regulationSlice.reducer;
