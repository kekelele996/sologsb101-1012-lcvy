/**
 * 标定 slice（台网中心侧）：维护标定记录、筛选条件与灵敏度派生值；
 * 同时维护更换记录（合格评定与更换提醒同属标定成果的下游动作）。
 *
 * 响应结论一律按「标定当天生效的检定规程版本」判定：
 * - 新建标定：同趟（tripNo）共用一版规程，按规程号+标定日期解析；
 * - 编辑标定：只读不符记录禁止改；改日期/趟次/规程号会重解析，已出结论的保留原结论直至用户重判；
 * - 重判失败只回写本方标定的 judgeError，规程不动。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type {
  Calibration,
  CalibrationFilterState,
  ResponseVerdict,
} from '@/types/calibration';
import { createEmptyCalibrationFilter, sensitivityDelta } from '@/types/calibration';
import type { Replace, ReplaceFilterState, ReplaceState } from '@/types/replace';
import { canTransition, createEmptyReplaceFilter } from '@/types/replace';
import type { Instrument } from '@/types/instrument';
import type { VerificationRegulation } from '@/types/regulation';
import {
  judgeAgainst,
  rejudgeAgainstCurrent,
  resolveBinding,
} from '@/utils/calibration';
import type { RootState } from '@/stores/store';

/** 选择器入参统一用 RootState */
type WithCalibration = RootState;

export interface CalibrationSliceState {
  calibrations: Calibration[];
  replaces: Replace[];
  instruments: Instrument[];
  ready: boolean;
  error: string | null;
  filter: CalibrationFilterState;
  replaceFilter: ReplaceFilterState;
  /** 最近一次操作回执 */
  lastReceipt: string;
}

const initialState: CalibrationSliceState = {
  calibrations: [],
  replaces: [],
  instruments: [],
  ready: false,
  error: null,
  filter: createEmptyCalibrationFilter(),
  replaceFilter: createEmptyReplaceFilter(),
  lastReceipt: '',
};

/** 新建标定入参：结论由规程判，不由调用方传 */
export interface CreateCalibrationPayload {
  instrumentId: string;
  date: string;
  tripNo: string;
  regulationCode: string;
  sensitivity: number;
  selfNoise: number;
  operator: string;
  agency: string;
  remark: string;
}

/** 取仪器类型，找不到按宽频带兜底（旧逻辑同口径） */
async function loadInstrumentType(instrumentId: string): Promise<string> {
  const instrument = await db.instruments.get(instrumentId);
  return instrument?.type ?? '宽频带';
}

/** 同趟标定统一绑定：以趟次内标定日期（同趟同日）解析规程 */
async function loadRegulations(): Promise<VerificationRegulation[]> {
  return db.regulations.toArray();
}

export const createCalibration = createAsyncThunk(
  'calibration/createCalibration',
  async (payload: CreateCalibrationPayload, { rejectWithValue }) => {
    const regulations = await loadRegulations();
    const resolution = resolveBinding(regulations, {
      date: payload.date,
      regulationCode: payload.regulationCode,
    });
    if (resolution.status === 'readonlyMismatch' || !resolution.regulation) {
      return rejectWithValue(
        `无法绑定检定规程（${resolution.reason}），请先到「检定规程」核对规程号与生效日期`
      );
    }
    const regulation = resolution.regulation;
    const instrument = await db.instruments.get(payload.instrumentId);
    const outcome = judgeAgainst(
      regulation,
      {
        type: instrument?.type ?? '宽频带',
        sensitivity: payload.sensitivity,
        selfNoise: payload.selfNoise,
      },
      'on-date'
    );
    const now = Date.now();
    // 类型未覆盖等：先挂着（待重判），错误只记本方标定，规程不动
    const pending = outcome.verdict === '待判定' || !outcome.basis;
    const row: Calibration = {
      id: createId('cal'),
      instrumentId: payload.instrumentId,
      date: payload.date,
      tripNo: payload.tripNo,
      sensitivity: payload.sensitivity,
      selfNoise: payload.selfNoise,
      responseVerdict: outcome.verdict,
      regulationId: regulation.id,
      regulationCode: regulation.regulationCode,
      bindStatus: pending ? 'pendingRejudge' : 'bound',
      verdictBasis: outcome.basis,
      judgeError: pending ? outcome.error || '未得出结论，待重判' : '',
      operator: payload.operator,
      agency: payload.agency,
      remark: payload.remark,
      createdAt: now,
      updatedAt: now,
    };
    await db.transaction('rw', [db.calibrations, db.instruments], async () => {
      await db.calibrations.put(row);
      if (instrument && !pending) {
        await db.instruments.update(instrument.id, {
          state: outcome.verdict === '不合格' ? '待标定' : '在用',
          updatedAt: now,
        } as never);
      }
    });
    return row;
  }
);

/** 编辑标定入参（均可选） */
export type UpdateCalibrationPatch = Partial<
  Omit<Calibration, 'id' | 'createdAt' | 'verdictBasis'>
>;

export const updateCalibration = createAsyncThunk(
  'calibration/updateCalibration',
  async (payload: { id: string; patch: UpdateCalibrationPatch }, { rejectWithValue }) => {
    const existing = await db.calibrations.get(payload.id);
    if (!existing) return rejectWithValue('标定记录不存在');
    if (existing.bindStatus === 'readonlyMismatch') {
      return rejectWithValue('该记录对账不符，按只读保留，不允许编辑');
    }

    const nextDate = payload.patch.date ?? existing.date;
    const nextTrip = payload.patch.tripNo ?? existing.tripNo;
    const nextCode = payload.patch.regulationCode ?? existing.regulationCode;
    const nextInstrumentId = payload.patch.instrumentId ?? existing.instrumentId;
    const nextSensitivity = payload.patch.sensitivity ?? existing.sensitivity;
    const nextNoise = payload.patch.selfNoise ?? existing.selfNoise;

    // 日期 / 趟次 / 规程号 / 仪器任一变化都要重解析绑定
    const rebindKeyChanged =
      payload.patch.date !== undefined ||
      payload.patch.tripNo !== undefined ||
      payload.patch.regulationCode !== undefined ||
      payload.patch.instrumentId !== undefined;
    const measuresChanged =
      payload.patch.sensitivity !== undefined || payload.patch.selfNoise !== undefined;

    const regulations = await loadRegulations();
    let regulationId = existing.regulationId;
    let regulationCode = existing.regulationCode;
    let bindStatus = existing.bindStatus;
    let responseVerdict: ResponseVerdict = payload.patch.responseVerdict ?? existing.responseVerdict;
    let verdictBasis = existing.verdictBasis;
    let judgeError = existing.judgeError;

    if (rebindKeyChanged) {
      const resolution = resolveBinding(regulations, { date: nextDate, regulationCode: nextCode });
      if (resolution.status === 'readonlyMismatch' || !resolution.regulation) {
        return rejectWithValue(
          `改后无法绑定检定规程（${resolution.reason}），记录未保存`
        );
      }
      regulationId = resolution.regulation.id;
      regulationCode = resolution.regulation.regulationCode;
    }

    const regulation = regulations.find((item) => item.id === regulationId) ?? null;

    // 已出结论且仅改文字字段：照旧保留依据；改了判据输入则按所绑版本重新判定
    if (measuresChanged || rebindKeyChanged) {
      if (regulation) {
        const type = await loadInstrumentType(nextInstrumentId);
        const mode = verdictBasis?.mode === 'current' ? 'current' : 'on-date';
        const outcome = judgeAgainst(
          regulation,
          { type, sensitivity: nextSensitivity, selfNoise: nextNoise },
          mode
        );
        const pending = outcome.verdict === '待判定' || !outcome.basis;
        responseVerdict = outcome.verdict;
        verdictBasis = outcome.basis;
        bindStatus = pending ? 'pendingRejudge' : 'bound';
        judgeError = pending ? outcome.error || '未得出结论，待重判' : '';
      } else {
        bindStatus = 'pendingRejudge';
        judgeError = '绑定规程缺失，待重判';
      }
    }
    void nextTrip;

    const now = Date.now();
    await db.calibrations.update(payload.id, {
      ...payload.patch,
      regulationId,
      regulationCode,
      responseVerdict,
      bindStatus,
      verdictBasis,
      judgeError,
      updatedAt: now,
    } as never);
    return payload;
  }
);

export const removeCalibration = createAsyncThunk(
  'calibration/removeCalibration',
  async (calibrationId: string) => {
    await db.calibrations.delete(calibrationId);
    return calibrationId;
  }
);

/**
 * 批量手工改响应结论（仅对非只读记录）。
 * 若记录此前未出结论（无判据快照），按所绑版本同步固化依据，保证每条结论都写得清依据哪版；
 * 改回「待判定」时解除已出结论状态，重新挂起待重判。
 */
export const bulkSetVerdict = createAsyncThunk(
  'calibration/bulkSetVerdict',
  async (payload: { ids: string[]; verdict: ResponseVerdict }) => {
    const now = Date.now();
    const regulations = await db.regulations.toArray();
    const instrumentTypes = new Map<string, string>();
    await db.instruments.each((instrument) => instrumentTypes.set(instrument.id, instrument.type));
    await db.calibrations
      .where('id')
      .anyOf(payload.ids)
      .modify((row) => {
        if (row.bindStatus === 'readonlyMismatch') return;
        row.responseVerdict = payload.verdict;
        if (payload.verdict === '待判定') {
          row.bindStatus = 'pendingRejudge';
          row.verdictBasis = null;
          row.judgeError = row.judgeError || '结论被手工置回待判定，等待重判';
        } else if (row.verdictBasis === null && row.regulationId) {
          const regulation = regulations.find((item) => item.id === row.regulationId);
          if (regulation) {
            const outcome = judgeAgainst(
              regulation,
              {
                type: instrumentTypes.get(row.instrumentId) ?? '宽频带',
                sensitivity: row.sensitivity,
                selfNoise: row.selfNoise,
              },
              'on-date'
            );
            // 手工结论以规程版本为依据固化；数值与手工结论不一致时以手工结论为准但限值仍留痕
            row.verdictBasis = outcome.basis ?? {
              regulationId: regulation.id,
              regulationCode: regulation.regulationCode,
              edition: regulation.edition,
              mode: 'on-date',
              criterion: regulation.criteria[instrumentTypes.get(row.instrumentId) as Instrument['type']]
                ? { ...regulation.criteria[instrumentTypes.get(row.instrumentId) as Instrument['type']]! }
                : { sensitivityMin: 0, sensitivityMax: 0, selfNoiseLimit: 0 },
              judgedAt: now,
            };
            row.bindStatus = 'bound';
            row.judgeError = '';
          }
        }
        row.updatedAt = now;
      });
    return payload;
  }
);

/**
 * 按现行版重判单条标定（换版 / 作废后挂起记录用）。
 * 失败只改本方标定（bindStatus 保持 pendingRejudge、写 judgeError），规程不动。
 */
export const rejudgeCalibration = createAsyncThunk(
  'calibration/rejudgeCalibration',
  async (calibrationId: string, { rejectWithValue }) => {
    const calibration = await db.calibrations.get(calibrationId);
    if (!calibration) return rejectWithValue('标定记录不存在');
    if (calibration.bindStatus === 'readonlyMismatch') {
      return rejectWithValue('对账不符记录只读保留，不参与重判');
    }
    const instrument = await db.instruments.get(calibration.instrumentId);
    const regulations = await loadRegulations();
    const patch = rejudgeAgainstCurrent(
      calibration,
      instrument?.type ?? '宽频带',
      regulations
    );
    await db.transaction('rw', [db.calibrations, db.instruments], async () => {
      await db.calibrations.update(calibrationId, patch as never);
      if (instrument && patch.bindStatus === 'bound') {
        await db.instruments.update(instrument.id, {
          state: patch.responseVerdict === '不合格' ? '待标定' : '在用',
          updatedAt: Date.now(),
        } as never);
      }
    });
    return { id: calibrationId, ...patch };
  }
);

/** 批量重判：逐条独立处理，单条失败不影响其他标定，规程始终不动 */
export const rejudgeCalibrations = createAsyncThunk(
  'calibration/rejudgeCalibrations',
  async (ids: string[]) => {
    let succeeded = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const calibration = await db.calibrations.get(id);
        if (!calibration || calibration.bindStatus === 'readonlyMismatch') {
          failed += 1;
          continue;
        }
        const instrument = await db.instruments.get(calibration.instrumentId);
        const regulations = await loadRegulations();
        const patch = rejudgeAgainstCurrent(
          calibration,
          instrument?.type ?? '宽频带',
          regulations
        );
        await db.calibrations.update(id, patch as never);
        if (patch.bindStatus === 'bound') succeeded += 1;
        else failed += 1;
      } catch {
        // 重判失败只重试本方标定：错误落标定行，规程不动
        await db.calibrations.update(id, {
          bindStatus: 'pendingRejudge',
          judgeError: '重判执行异常，可再次重试（规程未改动）',
          updatedAt: Date.now(),
        } as never);
        failed += 1;
      }
    }
    return { succeeded, failed };
  }
);

/* ------------------------------ 更换记录 ------------------------------ */

export const createReplace = createAsyncThunk(
  'calibration/createReplace',
  async (payload: Omit<Replace, 'id' | 'createdAt' | 'updatedAt'>) => {
    const now = Date.now();
    const row: Replace = { ...payload, id: createId('rpl'), createdAt: now, updatedAt: now };
    await db.replaces.put(row);
    return row;
  }
);

export const updateReplace = createAsyncThunk(
  'calibration/updateReplace',
  async (payload: { id: string; patch: Partial<Replace> }) => {
    await db.replaces.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

/**
 * 推进更换状态机：
 * 流转到「已更换」时回写仪器序列号并置为在用（更换完成后回写仪器序列号并归档旧记录）。
 */
export const transitionReplace = createAsyncThunk(
  'calibration/transitionReplace',
  async (
    payload: { id: string; next: ReplaceState },
    { rejectWithValue }
  ) => {
    const replace = await db.replaces.get(payload.id);
    if (!replace) return rejectWithValue('更换记录不存在');
    if (!canTransition(replace.state, payload.next)) {
      return rejectWithValue(`状态机不允许从「${replace.state}」流转到「${payload.next}」`);
    }
    const now = Date.now();
    await db.transaction('rw', [db.replaces, db.instruments], async () => {
      await db.replaces.update(payload.id, { state: payload.next, updatedAt: now } as never);
      if (payload.next === '已更换' && replace.newSerialNo) {
        await db.instruments.update(replace.instrumentId, {
          serialNo: replace.newSerialNo,
          state: '在用',
          updatedAt: now,
        } as never);
      }
    });
    return payload;
  }
);

export const removeReplace = createAsyncThunk('calibration/removeReplace', async (id: string) => {
  await db.replaces.delete(id);
  return id;
});

const calibrationSlice = createSlice({
  name: 'calibration',
  initialState,
  reducers: {
    setCalibrations(state, action: PayloadAction<Calibration[]>) {
      state.calibrations = action.payload;
      state.ready = true;
      state.error = null;
    },
    setReplaces(state, action: PayloadAction<Replace[]>) {
      state.replaces = action.payload;
    },
    setInstrumentsForCalibration(state, action: PayloadAction<Instrument[]>) {
      state.instruments = action.payload;
    },
    patchFilter(state, action: PayloadAction<Partial<CalibrationFilterState>>) {
      state.filter = { ...state.filter, ...action.payload };
    },
    resetFilter(state) {
      state.filter = createEmptyCalibrationFilter();
    },
    patchReplaceFilter(state, action: PayloadAction<Partial<ReplaceFilterState>>) {
      state.replaceFilter = { ...state.replaceFilter, ...action.payload };
    },
    resetReplaceFilter(state) {
      state.replaceFilter = createEmptyReplaceFilter();
    },
    setCalibrationError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setCalibrationReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createCalibration.fulfilled, (state, action) => {
        state.lastReceipt =
          action.payload.bindStatus === 'bound'
            ? `标定记录已保存，按 ${action.payload.regulationCode} 判定为「${action.payload.responseVerdict}」`
            : '标定记录已保存，暂未得出结论，已挂起待重判';
      })
      .addCase(createCalibration.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '标定记录保存失败';
      })
      .addCase(updateCalibration.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '标定记录更新失败';
      })
      .addCase(rejudgeCalibration.fulfilled, (state, action) => {
        state.lastReceipt =
          action.payload.bindStatus === 'bound'
            ? `重判完成：结论「${action.payload.responseVerdict}」`
            : `重判未完成：${action.payload.judgeError}`;
      })
      .addCase(rejudgeCalibration.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '重判失败';
      })
      .addCase(rejudgeCalibrations.fulfilled, (state, action) => {
        state.lastReceipt = `批量重判完成：成功 ${action.payload.succeeded} 条，仍挂起 ${action.payload.failed} 条（规程未改动）`;
      })
      .addCase(bulkSetVerdict.fulfilled, (state, action) => {
        state.lastReceipt = `已批量将 ${action.payload.ids.length} 条标定记录的响应结论改为「${action.payload.verdict}」`;
      })
      .addCase(transitionReplace.fulfilled, (state, action) => {
        state.lastReceipt =
          action.payload.next === '已更换'
            ? '更换完成：已回写仪器序列号并置为在用，旧记录已归档'
            : `更换记录状态已流转到「${action.payload.next}」`;
      })
      .addCase(transitionReplace.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '更换状态流转失败';
      });
  },
});

export const {
  setCalibrations,
  setReplaces,
  setInstrumentsForCalibration,
  patchFilter,
  resetFilter,
  patchReplaceFilter,
  resetReplaceFilter,
  setCalibrationError,
  setCalibrationReceipt,
} = calibrationSlice.actions;

let started = false;

/** 启动标定 / 更换 / 仪器表实时订阅（幂等） */
export function startCalibrationSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<Calibration>(() => db.calibrations).subscribe((rows) => {
    dispatch(setCalibrations(rows));
  });
  watchTable<Replace>(() => db.replaces).subscribe((rows) => {
    dispatch(setReplaces(rows));
  });
  watchTable<Instrument>(() => db.instruments).subscribe((rows) => {
    dispatch(setInstrumentsForCalibration(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectCalibrationState = (state: WithCalibration): CalibrationSliceState =>
  state.calibration;
export const selectCalibrations = (state: WithCalibration): Calibration[] =>
  state.calibration.calibrations;
export const selectReplaces = (state: WithCalibration): Replace[] => state.calibration.replaces;
export const selectCalibrationReady = (state: WithCalibration): boolean => state.calibration.ready;
export const selectCalibrationFilter = (state: WithCalibration): CalibrationFilterState =>
  state.calibration.filter;
export const selectReplaceFilter = (state: WithCalibration): ReplaceFilterState =>
  state.calibration.replaceFilter;
export const selectCalibrationReceipt = (state: WithCalibration): string =>
  state.calibration.lastReceipt;

export const selectCalibrationsOfInstrument = (
  state: WithCalibration,
  instrumentId: string | null | undefined
): Calibration[] => {
  if (!instrumentId) return [];
  return state.calibration.calibrations
    .filter((row) => row.instrumentId === instrumentId)
    .sort((a, b) => b.date.localeCompare(a.date));
};

export const selectReplacesOfInstrument = (
  state: WithCalibration,
  instrumentId: string | null | undefined
): Replace[] => {
  if (!instrumentId) return [];
  return state.calibration.replaces.filter((row) => row.instrumentId === instrumentId);
};

/** 待重判标定（换版 / 作废后挂起、未出结论） */
export const selectPendingRejudgeCalibrations = (state: WithCalibration): Calibration[] =>
  state.calibration.calibrations.filter((row) => row.bindStatus === 'pendingRejudge');

/** 对账不符、只读保留的标定 */
export const selectReadonlyMismatchCalibrations = (state: WithCalibration): Calibration[] =>
  state.calibration.calibrations.filter((row) => row.bindStatus === 'readonlyMismatch');

/** 标定 id → 灵敏度变化（相对同仪器上一次标定） */
export const selectSensitivityDeltas = (
  state: WithCalibration
): Record<string, ReturnType<typeof sensitivityDelta>> => {
  const result: Record<string, ReturnType<typeof sensitivityDelta>> = {};
  const grouped = new Map<string, Calibration[]>();
  state.calibration.calibrations.forEach((row) => {
    const list = grouped.get(row.instrumentId) ?? [];
    list.push(row);
    grouped.set(row.instrumentId, list);
  });
  grouped.forEach((list) => {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    sorted.forEach((row, index) => {
      const previous = index > 0 ? sorted[index - 1].sensitivity : null;
      result[row.id] = sensitivityDelta(row.sensitivity, previous);
    });
  });
  return result;
};

export default calibrationSlice.reducer;
