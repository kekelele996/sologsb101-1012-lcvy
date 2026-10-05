/**
 * 模块 3：/calibrations 标定记录台（台网中心）
 * 录入灵敏度 / 自噪，按「标定当天生效的检定规程版本」自动判响应结论；
 * 同趟出车（趟次号相同）的多台仪器落在同一版规程；
 * 挂起待重判的可发起重判，对账不符记录只读；支持批量手工改结论。
 * 复用 <FilterBar>、<QualifyTag>、<EmptyPanel>。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import FilterBar from '@/components/common/FilterBar';
import type { FilterModel } from '@/types/filter';
import StatBadge from '@/components/common/StatBadge';
import QualifyTag from '@/components/common/QualifyTag';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import { selectRegulations } from '@/stores/regulationSlice';
import {
  bulkSetVerdict,
  createCalibration,
  patchFilter,
  rejudgeCalibration,
  removeCalibration,
  resetFilter,
  selectCalibrationFilter,
  selectCalibrations,
  updateCalibration,
} from '@/stores/calibrationSlice';
import {
  RESPONSE_VERDICTS,
  sensitivityDelta,
  type Calibration,
  type ResponseVerdict,
} from '@/types/calibration';
import { INSTRUMENT_TYPES } from '@/types/instrument';
import { round } from '@/utils/geo';
import { initDatabase } from '@/utils/db';
import { basisText, criterionOf, findEffectiveRegulation } from '@/types/regulation';
import { makeTripNo } from '@/utils/calibration';

interface CalibrationFormValues {
  instrumentId: string;
  date: dayjs.Dayjs | null;
  tripNo: string;
  regulationCode: string;
  sensitivity: number;
  selfNoise: number;
  operator: string;
  agency: string;
  remark: string;
}

/** 标定行：附带仪器、台站、台阵信息与灵敏度变化 */
interface CalibrationRow {
  row: Calibration;
  instrumentModel: string;
  instrumentType: string;
  serialNo: string;
  stationCode: string;
  arrayName: string;
  arrayId: string;
  delta: ReturnType<typeof sensitivityDelta>;
}

export default function CalibrationBoard() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();
  const [searchParams, setSearchParams] = useSearchParams();

  const calibrations = useAppSelector(selectCalibrations);
  const instruments = useAppSelector(selectInstruments);
  const stations = useAppSelector(selectStations);
  const arrays = useAppSelector(selectArrays);
  const regulations = useAppSelector(selectRegulations);
  const filter = useAppSelector(selectCalibrationFilter);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [trendInstrumentId, setTrendInstrumentId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [rejudgingId, setRejudgingId] = useState<string | null>(null);
  const [form] = Form.useForm<CalibrationFormValues>();

  useEffect(() => {
    dispatch(
      patchFilter({
        keyword: searchParams.get('kw') ?? '',
        verdicts: (searchParams.get('verdict')?.split(',').filter(Boolean) ?? []) as ResponseVerdict[],
        instrumentTypes: searchParams.get('type')?.split(',').filter(Boolean) ?? [],
        onlyOverdue: searchParams.get('overdue') === '1',
      })
    );
    if (arrays.length === 0) void initDatabase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const instrumentIndex = useMemo(() => {
    const map = new Map<
      string,
      { model: string; type: string; serialNo: string; stationCode: string; arrayName: string; arrayId: string }
    >();
    instruments.forEach((instrument) => {
      const station = stations.find((row) => row.id === instrument.stationId);
      const array = station ? arrays.find((row) => row.id === station.arrayId) : undefined;
      map.set(instrument.id, {
        model: instrument.model,
        type: instrument.type,
        serialNo: instrument.serialNo,
        stationCode: station?.code ?? '未知台站',
        arrayName: array?.name ?? '未知台阵',
        arrayId: array?.id ?? '',
      });
    });
    return map;
  }, [arrays, instruments, stations]);

  /** 逐仪器排序后的标定序列，用于计算灵敏度变化 */
  const deltaIndex = useMemo(() => {
    const grouped = new Map<string, Calibration[]>();
    calibrations.forEach((row) => {
      const list = grouped.get(row.instrumentId) ?? [];
      list.push(row);
      grouped.set(row.instrumentId, list);
    });
    const result = new Map<string, ReturnType<typeof sensitivityDelta>>();
    grouped.forEach((list) => {
      const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
      sorted.forEach((row, index) => {
        result.set(row.id, sensitivityDelta(row.sensitivity, index > 0 ? sorted[index - 1].sensitivity : null));
      });
    });
    return result;
  }, [calibrations]);

  const rows = useMemo<CalibrationRow[]>(() => {
    return calibrations
      .map((row) => {
        const info = instrumentIndex.get(row.instrumentId);
        return {
          row,
          instrumentModel: info?.model ?? '仪器已删除',
          instrumentType: info?.type ?? '未知',
          serialNo: info?.serialNo ?? '—',
          stationCode: info?.stationCode ?? '—',
          arrayName: info?.arrayName ?? '—',
          arrayId: info?.arrayId ?? '',
          delta: deltaIndex.get(row.id) ?? sensitivityDelta(row.sensitivity, null),
        };
      })
      .filter((item) => {
        const keyword = filter.keyword.trim();
        if (keyword.length > 0) {
          const haystack = `${item.instrumentModel}${item.serialNo}${item.stationCode}${item.arrayName}${item.row.operator}${item.row.agency}${item.row.tripNo}${item.row.regulationCode}`;
          if (!haystack.includes(keyword)) return false;
        }
        if (filter.verdicts.length > 0 && !filter.verdicts.includes(item.row.responseVerdict)) return false;
        if (filter.instrumentTypes.length > 0 && !filter.instrumentTypes.includes(item.instrumentType)) return false;
        if (filter.onlyOverdue && item.row.responseVerdict !== '不合格') return false;
        return true;
      })
      .sort((a, b) => b.row.date.localeCompare(a.row.date));
  }, [calibrations, deltaIndex, filter, instrumentIndex]);

  const totals = useMemo(() => {
    const judged = rows.filter((item) => item.row.responseVerdict !== '待判定');
    const unqualified = rows.filter((item) => item.row.responseVerdict === '不合格').length;
    const meanSensitivity =
      rows.length === 0
        ? 0
        : round(rows.reduce((sum, item) => sum + item.row.sensitivity, 0) / rows.length, 1);
    const meanNoise =
      rows.length === 0 ? 0 : round(rows.reduce((sum, item) => sum + item.row.selfNoise, 0) / rows.length, 2);
    return {
      count: rows.length,
      unqualified,
      qualifyRate: judged.length === 0 ? 0 : round(((judged.length - unqualified) / judged.length) * 100, 1),
      meanSensitivity,
      meanNoise,
      operatorCount: new Set(rows.map((item) => item.row.operator)).size,
      pendingRejudge: rows.filter((item) => item.row.bindStatus === 'pendingRejudge').length,
      readonly: rows.filter((item) => item.row.bindStatus === 'readonlyMismatch').length,
    };
  }, [rows]);

  const filterModel: FilterModel = {
    keyword: filter.keyword,
    verdicts: filter.verdicts,
    instrumentTypes: filter.instrumentTypes,
  };

  const trendRows = useMemo(() => {
    const targetId = trendInstrumentId ?? rows[0]?.row.instrumentId ?? null;
    if (!targetId) return { targetId: null as string | null, points: [] as Calibration[] };
    return {
      targetId,
      points: calibrations
        .filter((row) => row.instrumentId === targetId)
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  }, [calibrations, rows, trendInstrumentId]);

  /** 表单当前所选日期 + 规程号对应的生效版本与该仪器类型判据 */
  const watchDate = Form.useWatch('date', form);
  const watchCode = Form.useWatch('regulationCode', form);
  const watchInstrumentId = Form.useWatch('instrumentId', form);
  const draftDate = watchDate ? watchDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD');
  const draftRegulation = useMemo(
    () => (watchCode ? findEffectiveRegulation(regulations, watchCode, draftDate) : null),
    [draftDate, regulations, watchCode]
  );
  const draftInstrumentType =
    instruments.find((item) => item.id === watchInstrumentId)?.type ?? '宽频带';
  const draftCriterion = criterionOf(draftRegulation, draftInstrumentType);

  /** 已有的趟次号（供同趟续录选择） */
  const existingTrips = useMemo(() => {
    const map = new Map<string, { date: string; code: string }>();
    calibrations.forEach((row) => {
      if (!map.has(row.tripNo)) map.set(row.tripNo, { date: row.date, code: row.regulationCode });
    });
    return [...map.entries()].sort((a, b) => b[1].date.localeCompare(a[1].date));
  }, [calibrations]);

  const activeRegulationCodes = useMemo(
    () => [...new Set(regulations.filter((row) => row.status === '生效中').map((row) => row.regulationCode))],
    [regulations]
  );

  const openCreate = () => {
    setEditingId(null);
    const firstInstrument = instruments[0];
    form.setFieldsValue({
      instrumentId: firstInstrument?.id ?? '',
      date: dayjs(),
      tripNo: makeTripNo(dayjs().format('YYYY-MM-DD')),
      regulationCode: activeRegulationCodes[0] ?? '',
      sensitivity: 1500,
      selfNoise: 1.5,
      operator: '陈立群',
      agency: '省地震局计量站',
      remark: '',
    });
    setModalOpen(true);
  };

  const openEdit = (row: Calibration) => {
    setEditingId(row.id);
    form.setFieldsValue({
      instrumentId: row.instrumentId,
      date: dayjs(row.date),
      tripNo: row.tripNo,
      regulationCode: row.regulationCode,
      sensitivity: row.sensitivity,
      selfNoise: row.selfNoise,
      operator: row.operator,
      agency: row.agency,
      remark: row.remark,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      const payload = {
        instrumentId: values.instrumentId,
        date: values.date ? values.date.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
        tripNo: values.tripNo.trim(),
        regulationCode: values.regulationCode?.trim() ?? '',
        sensitivity: Number(values.sensitivity),
        selfNoise: Number(values.selfNoise),
        operator: values.operator.trim(),
        agency: values.agency?.trim() ?? '',
        remark: values.remark?.trim() ?? '',
      };
      if (editingId) {
        await dispatch(updateCalibration({ id: editingId, patch: payload })).unwrap();
        message.success('标定记录已更新，结论已按绑定规程版本重新核定');
      } else {
        const saved = await dispatch(createCalibration(payload)).unwrap();
        if (saved.bindStatus === 'bound') {
          message.success(`标定记录已保存，按 ${saved.regulationCode} 自动判定为「${saved.responseVerdict}」`);
        } else {
          message.warning(`记录已保存但暂挂待重判：${saved.judgeError}`);
        }
      }
      setModalOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleBulkVerdict = async (verdict: ResponseVerdict) => {
    const actionable = selectedKeys.filter((id) => {
      const row = calibrations.find((item) => item.id === id);
      return row && row.bindStatus !== 'readonlyMismatch';
    });
    if (actionable.length === 0) {
      message.warning('请先勾选可操作的标定记录（对账不符记录只读）');
      return;
    }
    await dispatch(bulkSetVerdict({ ids: actionable, verdict })).unwrap();
    message.success(`已将 ${actionable.length} 条标定记录的响应结论改为「${verdict}」`);
    setSelectedKeys([]);
  };

  const handleRejudge = async (id: string) => {
    setRejudgingId(id);
    try {
      const result = await dispatch(rejudgeCalibration(id)).unwrap();
      if (result.bindStatus === 'bound') {
        message.success(`已按现行版重判为「${result.responseVerdict}」，依据已固化`);
      } else {
        message.warning(result.judgeError || '仍无法重判，继续挂起（规程未改动）');
      }
    } catch (error) {
      message.error(typeof error === 'string' ? error : '重判失败');
    } finally {
      setRejudgingId(null);
    }
  };

  const handleFilterChange = (next: FilterModel, switchValue: boolean) => {
    dispatch(
      patchFilter({
        keyword: next.keyword,
        verdicts: ((next.verdicts as string[]) ?? []) as ResponseVerdict[],
        instrumentTypes: (next.instrumentTypes as string[]) ?? [],
        onlyOverdue: switchValue,
      })
    );
    const params = new URLSearchParams();
    if (next.keyword.trim()) params.set('kw', next.keyword.trim());
    if (((next.verdicts as string[]) ?? []).length > 0) params.set('verdict', ((next.verdicts as string[]) ?? []).join(','));
    if (((next.instrumentTypes as string[]) ?? []).length > 0)
      params.set('type', ((next.instrumentTypes as string[]) ?? []).join(','));
    if (switchValue) params.set('overdue', '1');
    setSearchParams(params, { replace: true });
  };

  const handleReset = () => {
    dispatch(resetFilter());
    setSearchParams(new URLSearchParams(), { replace: true });
  };

  /** 灵敏度趋势图坐标 */
  const trendChart = useMemo(() => {
    const points = trendRows.points;
    if (points.length === 0) {
      return { line: '', dots: [] as Array<{ id: string; cx: number; cy: number; date: string; sensitivity: number }>, min: 0, max: 0 };
    }
    const sensitivities = points.map((row) => row.sensitivity);
    const min = Math.min(...sensitivities) * 0.98;
    const max = Math.max(...sensitivities) * 1.02;
    const left = 58;
    const right = 340;
    const top = 20;
    const bottom = 190;
    const toX = (index: number): number =>
      points.length === 1 ? (left + right) / 2 : left + (index * (right - left)) / (points.length - 1);
    const toY = (value: number): number =>
      max - min < 1e-6 ? (top + bottom) / 2 : bottom - ((value - min) / (max - min)) * (bottom - top);
    const dots = points.map((row, index) => ({
      id: row.id,
      cx: Number(toX(index).toFixed(1)),
      cy: Number(toY(row.sensitivity).toFixed(1)),
      date: row.date,
      sensitivity: row.sensitivity,
    }));
    return { line: dots.map((dot) => `${dot.cx},${dot.cy}`).join(' '), dots, min, max };
  }, [trendRows]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            标定记录台（台网中心）
          </Typography.Title>
          <p className="gb-hint">
            录入灵敏度、自噪与趟次号，系统按「标定当天生效的检定规程版本」自动判响应结论；
            同趟出车的多台仪器共用趟次号、落在同一版规程。判据由计量站在「检定规程管理」维护。
          </p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void initDatabase()}>
            补齐演示数据
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增标定记录
          </Button>
        </Space>
      </div>

      {(totals.pendingRejudge > 0 || totals.readonly > 0) && (
        <Alert
          type={totals.pendingRejudge > 0 ? 'warning' : 'info'}
          showIcon
          message={
            <Space wrap>
              {totals.pendingRejudge > 0 ? <span>{totals.pendingRejudge} 条标定因规程换版 / 作废挂起待重判</span> : null}
              {totals.readonly > 0 ? <span>{totals.readonly} 条对账不符记录只读保留</span> : null}
              <Button size="small" type="link" onClick={() => navigate('/reconciliation')}>
                前往规程对账处理
              </Button>
            </Space>
          }
        />
      )}

      <div className="gb-stats-row">
        <StatBadge label="标定记录" value={totals.count} suffix="次" tone="primary" />
        <StatBadge
          label="不合格"
          value={totals.unqualified}
          suffix="次"
          tone={totals.unqualified > 0 ? 'danger' : 'success'}
        />
        <StatBadge label="合格率" value={totals.qualifyRate} percent={totals.qualifyRate} tone="success" />
        <StatBadge label="平均灵敏度" value={totals.meanSensitivity} suffix="V·s/m" tone="info" />
        <StatBadge label="平均自噪" value={totals.meanNoise} suffix="" tone="warning" />
        <StatBadge label="待重判 / 只读" value={`${totals.pendingRejudge} / ${totals.readonly}`} tone="default" />
      </div>

      <FilterBar
        modelValue={filterModel}
        selects={[
          {
            key: 'verdicts',
            label: '响应结论',
            options: RESPONSE_VERDICTS.map((verdict) => ({ label: verdict, value: verdict })),
          },
          {
            key: 'instrumentTypes',
            label: '仪器类型',
            options: INSTRUMENT_TYPES.map((type) => ({ label: type, value: type })),
          },
        ]}
        hasSwitch
        switchLabel="仅看不合格记录"
        switchValue={filter.onlyOverdue}
        keywordPlaceholder="搜索型号 / 序列号 / 台站 / 趟次号 / 规程号 / 标定人"
        onChange={handleFilterChange}
        onReset={handleReset}
        extra={
          <Space size={6}>
            <span className="gb-hint">批量改结论：</span>
            {RESPONSE_VERDICTS.map((verdict) => (
              <Button key={verdict} size="small" onClick={() => void handleBulkVerdict(verdict)}>
                {verdict}
              </Button>
            ))}
          </Space>
        }
      />

      {rows.length === 0 ? (
        <EmptyPanel
          title={calibrations.length === 0 ? '还没有标定记录' : '没有符合条件的标定记录'}
          description="先到「台站仪器」页登记仪器，再按趟次录入灵敏度与自噪，系统按当天生效规程版本判定，形成可追溯台账。"
          actionText="新增标定记录"
          secondaryText="重置筛选"
          onAction={openCreate}
          onSecondary={handleReset}
        />
      ) : (
        <Table
          rowKey={(item) => item.row.id}
          className="gb-table-compact"
          dataSource={rows}
          pagination={{ pageSize: 12, showSizeChanger: false }}
          rowSelection={{
            selectedRowKeys: selectedKeys,
            getCheckboxProps: (item) => ({ disabled: item.row.bindStatus === 'readonlyMismatch' }),
            onChange: (keys) => setSelectedKeys(keys as string[]),
          }}
          columns={[
            {
              title: '仪器',
              width: 200,
              render: (_: unknown, item: CalibrationRow) => (
                <div>
                  <div>
                    {item.instrumentModel} <Tag>{item.instrumentType}</Tag>
                  </div>
                  <div className="gb-hint gb-mono">{item.serialNo}</div>
                </div>
              ),
            },
            {
              title: '台站 / 台阵',
              width: 160,
              render: (_: unknown, item: CalibrationRow) => (
                <div>
                  <div className="gb-mono">{item.stationCode}</div>
                  <div className="gb-hint">{item.arrayName}</div>
                </div>
              ),
            },
            { title: '标定日期', dataIndex: ['row', 'date'], width: 110, className: 'gb-mono' },
            {
              title: '趟次号 / 规程',
              width: 210,
              render: (_: unknown, item: CalibrationRow) => (
                <div>
                  <div className="gb-mono">{item.row.tripNo}</div>
                  <Tooltip title={`依据：${basisText(item.row.verdictBasis)}`}>
                    <div className="gb-hint">
                      {item.row.regulationCode || '（无规程号）'}
                    </div>
                  </Tooltip>
                </div>
              ),
            },
            {
              title: '灵敏度 (V·s/m)',
              width: 150,
              align: 'right',
              render: (_: unknown, item: CalibrationRow) => (
                <div>
                  <span className="gb-mono">{item.row.sensitivity}</span>
                  {item.delta.comparable ? (
                    <div className={Math.abs(item.delta.percent) > 5 ? 'gb-danger gb-hint' : 'gb-hint'}>
                      变化 {item.delta.absolute > 0 ? '+' : ''}
                      {item.delta.absolute}（{item.delta.percent}%）
                    </div>
                  ) : (
                    <div className="gb-hint">首次标定</div>
                  )}
                </div>
              ),
            },
            {
              title: '自噪',
              width: 100,
              align: 'right',
              render: (_: unknown, item: CalibrationRow) => {
                const limit = item.row.verdictBasis?.criterion.selfNoiseLimit;
                const over = typeof limit === 'number' && item.row.selfNoise > limit;
                return <span className={over ? 'gb-danger gb-mono' : 'gb-mono'}>{item.row.selfNoise}</span>;
              },
            },
            {
              title: '响应结论 / 依据',
              width: 230,
              render: (_: unknown, item: CalibrationRow) => (
                <Space direction="vertical" size={2}>
                  <QualifyTag
                    verdict={item.row.responseVerdict}
                    sensitivity={item.row.sensitivity}
                    selfNoise={item.row.selfNoise}
                    size="small"
                  />
                  {item.row.bindStatus === 'pendingRejudge' ? (
                    <Tag color="orange">换版挂起 · 待重判</Tag>
                  ) : item.row.bindStatus === 'readonlyMismatch' ? (
                    <Tag color="default">对账不符 · 只读</Tag>
                  ) : (
                    <span className="gb-hint">{basisText(item.row.verdictBasis)}</span>
                  )}
                  {item.row.judgeError && item.row.bindStatus !== 'bound' ? (
                    <span className="gb-danger gb-hint">{item.row.judgeError}</span>
                  ) : null}
                </Space>
              ),
            },
            {
              title: '标定人 / 机构',
              width: 160,
              render: (_: unknown, item: CalibrationRow) => (
                <div>
                  <div>{item.row.operator || '未署名'}</div>
                  <div className="gb-hint">{item.row.agency || '未填写机构'}</div>
                </div>
              ),
            },
            { title: '备注', dataIndex: ['row', 'remark'], ellipsis: true },
            {
              title: '操作',
              width: 220,
              render: (_: unknown, item: CalibrationRow) =>
                item.row.bindStatus === 'readonlyMismatch' ? (
                  <Tooltip title="对账不符记录只读保留，请到「规程对账」查看原因">
                    <Button size="small" disabled>
                      只读
                    </Button>
                  </Tooltip>
                ) : (
                  <Space size={6} wrap>
                    {item.row.bindStatus === 'pendingRejudge' ? (
                      <Button
                        size="small"
                        type="primary"
                        loading={rejudgingId === item.row.id}
                        onClick={() => void handleRejudge(item.row.id)}
                      >
                        重判
                      </Button>
                    ) : null}
                    <Button size="small" onClick={() => setTrendInstrumentId(item.row.instrumentId)}>
                      趋势
                    </Button>
                    <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(item.row)}>
                      编辑
                    </Button>
                    <Popconfirm
                      title="删除标定记录"
                      description={`确认删除 ${item.row.date} 的标定记录？`}
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() =>
                        void dispatch(removeCalibration(item.row.id))
                          .unwrap()
                          .then(() => message.success('标定记录已删除'))
                      }
                    >
                      <Button size="small" danger icon={<DeleteOutlined />}>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
            },
          ]}
        />
      )}

      <Card
        className="gb-panel"
        size="small"
        title="灵敏度趋势"
        extra={
          <Select
            style={{ width: 260 }}
            placeholder="选择仪器"
            value={trendRows.targetId ?? undefined}
            onChange={(value) => setTrendInstrumentId(value)}
            options={instruments.map((instrument) => ({
              label: `${instrument.model}（${instrument.serialNo}）`,
              value: instrument.id,
            }))}
          />
        }
      >
        {trendChart.dots.length === 0 ? (
          <EmptyPanel title="暂无可绘制的趋势" description="该仪器还没有标定记录。" compact />
        ) : (
          <>
            <svg viewBox="0 0 380 220" className="gb-chart">
              <line x1="58" y1="190" x2="352" y2="190" stroke="#b9c6d4" />
              <line x1="58" y1="20" x2="58" y2="190" stroke="#b9c6d4" />
              <text x="8" y="24" className="gb-chart-axis">
                {round(trendChart.max, 0)}
              </text>
              <text x="8" y="194" className="gb-chart-axis">
                {round(trendChart.min, 0)}
              </text>
              <polyline points={trendChart.line} fill="none" stroke="#1e3a5f" strokeWidth="2" />
              {trendChart.dots.map((dot) => (
                <g key={dot.id}>
                  <circle cx={dot.cx} cy={dot.cy} r="4.5" fill="#7fd1e8" stroke="#1e3a5f" />
                  <text x={dot.cx - 22} y={220 - 4} className="gb-chart-axis">
                    {dot.date.slice(2)}
                  </text>
                </g>
              ))}
            </svg>
            <p className="gb-hint">
              纵轴为灵敏度（V·s/m），横轴为标定日期；共 {trendChart.dots.length} 次标定。灵敏度变化超过 5%
              会以红色提示，供判断仪器漂移趋势；各点判据以其固化依据版本为准。
            </p>
          </>
        )}
      </Card>

      <p className="gb-hint">
        需要处理超期或不合格仪器？前往
        <Button type="link" size="small" onClick={() => navigate('/replacements')}>
          合格评定与更换
        </Button>
        登记更换并跟踪到复核闭环。
      </p>

      <Modal
        open={modalOpen}
        title={editingId ? '编辑标定记录' : '新增标定记录'}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        confirmLoading={submitting}
        okText={editingId ? '保存修改' : '保存并按规程判定'}
        width={680}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="instrumentId" label="被标定仪器" rules={[{ required: true, message: '请选择仪器' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              disabled={!!editingId && calibrations.find((row) => row.id === editingId)?.bindStatus === 'readonlyMismatch'}
              options={instruments.map((instrument) => {
                const info = instrumentIndex.get(instrument.id);
                return {
                  label: `${info?.arrayName ?? ''} / ${info?.stationCode ?? ''} · ${instrument.model}（${instrument.serialNo}）`,
                  value: instrument.id,
                };
              })}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="date" label="标定日期" rules={[{ required: true }]}>
                <DatePicker
                  style={{ width: '100%' }}
                  onChange={(value) => {
                    if (!editingId && value) {
                      form.setFieldValue('tripNo', makeTripNo(value.format('YYYY-MM-DD')));
                    }
                  }}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="趟次号（同趟出车共用）" required>
                <Space.Compact style={{ width: '100%' }}>
                  <Form.Item name="tripNo" noStyle rules={[{ required: true, message: '请填写或选择趟次号' }]}>
                    <Input maxLength={40} placeholder="如：PC20240930-HX01" />
                  </Form.Item>
                  <Select
                    style={{ width: 130 }}
                    placeholder="并入已趟"
                    value={undefined}
                    onChange={(trip: string) => {
                      const meta = existingTrips.find(([no]) => no === trip)?.[1];
                      form.setFieldsValue({
                        tripNo: trip,
                        date: meta ? dayjs(meta.date) : form.getFieldValue('date'),
                        regulationCode: meta?.code ?? form.getFieldValue('regulationCode'),
                      });
                    }}
                    options={existingTrips.map(([no, meta]) => ({
                      label: `${no}（${meta.date}）`,
                      value: no,
                    }))}
                  />
                </Space.Compact>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="regulationCode" label="检定规程号（按日期取生效版）" rules={[{ required: true, message: '请选择规程号' }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  options={[...new Set(regulations.map((row) => row.regulationCode))].map((code) => ({
                    label: code,
                    value: code,
                  }))}
                />
              </Form.Item>
            </Col>
          </Row>

          <Alert
            type={draftRegulation ? 'success' : 'error'}
            showIcon
            style={{ marginBottom: 12 }}
            message={
              draftRegulation ? (
                <span>
                  {draftDate} 当天生效：
                  <b>{draftRegulation.regulationCode} {draftRegulation.edition}</b>
                  （{draftRegulation.effectiveFrom} ~ {draftRegulation.effectiveTo ?? '至今'}）
                  {draftCriterion ? (
                    <span className="gb-mono">
                      {' '}· {draftInstrumentType} 灵敏度 {draftCriterion.sensitivityMin}~{draftCriterion.sensitivityMax}
                      ，自噪≤{draftCriterion.selfNoiseLimit}
                    </span>
                  ) : (
                    <span className="gb-danger"> · 该版未覆盖「{draftInstrumentType}」类型，保存后将挂起待重判</span>
                  )}
                </span>
              ) : (
                <span>
                  规程号 {watchCode || '（未选）'} 在 {draftDate} 没有生效版本，无法绑定；请核对日期或让计量站登记该版。
                </span>
              )
            }
          />

          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="sensitivity" label="灵敏度 (V·s/m)" rules={[{ required: true }]}>
                <InputNumber min={0} max={100000} step={0.01} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="selfNoise"
                label={draftCriterion ? `自噪（该版上限 ${draftCriterion.selfNoiseLimit}）` : '自噪'}
                rules={[{ required: true }]}
              >
                <InputNumber min={0} max={100} step={0.01} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="operator" label="标定人" rules={[{ required: true, message: '请填写标定人' }]}>
                <Input maxLength={20} placeholder="如：陈立群" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="agency" label="标定机构">
                <Input maxLength={40} placeholder="如：省地震局计量站" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} placeholder="如：响应曲线平滑 / 自噪接近上限" />
          </Form.Item>
          <p className="gb-hint" style={{ marginBottom: 0 }}>
            保存后系统自动判定并固化依据版本；脉冲响应的异常说明可在备注补充，最终结论以标定报告为准。
          </p>
        </Form>
      </Modal>
    </div>
  );
}
