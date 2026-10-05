/**
 * 模块：/regulations 检定规程与对账
 * 计量站维护检定规程（规程号、生效起止、类型区间）与标定批次；
 * 台网中心按标定当天生效的规程定响应结论，同趟出车落在同版；
 * 两边按规程号和标定日期对账，对不上的单列，重判失败只重试本方标定，规程不动。
 * 复用 <FilterBar>、<QualifyTag>、<EmptyPanel>。
 */
import { useEffect, useMemo, useState } from 'react';
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
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import StatBadge from '@/components/common/StatBadge';
import QualifyTag from '@/components/common/QualifyTag';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectInstruments } from '@/stores/instrumentSlice';
import {
  createBatch,
  createRegulation,
  invalidateRegulation,
  rejudgeCalibration,
  rejudgePending,
  removeBatch,
  removeRegulation,
  selectBatches,
  selectPendingRejudgeCount,
  selectReconciliation,
  selectRegulations,
  updateBatch,
  updateRegulation,
} from '@/stores/regulationSlice';
import type { CalibrationBatch, VerificationRegulation } from '@/types/regulation';
import {
  RECONCILE_STATUSES,
  REGULATION_STATUSES,
  type ReconcileStatus,
  type RegulationStatus,
} from '@/types/regulation';
import { INSTRUMENT_TYPES, type InstrumentType } from '@/types/instrument';
import { initDatabase } from '@/utils/db';

/* ------------------------------ 规程表单 ------------------------------ */

interface RegulationFormValues {
  code: string;
  name: string;
  agency: string;
  effectiveFrom: dayjs.Dayjs | null;
  effectiveTo: dayjs.Dayjs | null;
  status: RegulationStatus;
  remark: string;
  typeLimits: Record<InstrumentType, { sensitivityMin: number; sensitivityMax: number; selfNoiseLimit: number }>;
}

interface BatchFormValues {
  code: string;
  date: dayjs.Dayjs | null;
  remark: string;
}

const DEFAULT_TYPE_LIMITS: RegulationFormValues['typeLimits'] = {
  宽频带: { sensitivityMin: 800, sensitivityMax: 3000, selfNoiseLimit: 3.5 },
  短周期: { sensitivityMin: 100, sensitivityMax: 800, selfNoiseLimit: 3.5 },
  强震: { sensitivityMin: 0.1, sensitivityMax: 5, selfNoiseLimit: 3.5 },
};

export default function RegulationBoard() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const regulations = useAppSelector(selectRegulations);
  const batches = useAppSelector(selectBatches);
  const instruments = useAppSelector(selectInstruments);
  const reconciliation = useAppSelector(selectReconciliation);
  const pendingRejudgeCount = useAppSelector(selectPendingRejudgeCount);

  const [regModalOpen, setRegModalOpen] = useState(false);
  const [editingRegId, setEditingRegId] = useState<string | null>(null);
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [editingBatchId, setEditingBatchId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [regForm] = Form.useForm<RegulationFormValues>();
  const [batchForm] = Form.useForm<BatchFormValues>();

  useEffect(() => {
    if (regulations.length === 0) void initDatabase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------ 规程操作 ------------------------------ */

  const openCreateRegulation = () => {
    setEditingRegId(null);
    regForm.setFieldsValue({
      code: '',
      name: '',
      agency: '国家测震台网计量中心',
      effectiveFrom: dayjs(),
      effectiveTo: null,
      status: '现行',
      remark: '',
      typeLimits: DEFAULT_TYPE_LIMITS,
    });
    setRegModalOpen(true);
  };

  const openEditRegulation = (reg: VerificationRegulation) => {
    setEditingRegId(reg.id);
    const typeLimits = { ...DEFAULT_TYPE_LIMITS };
    INSTRUMENT_TYPES.forEach((type) => {
      const limit = reg.typeLimits[type];
      if (limit) {
        typeLimits[type] = {
          sensitivityMin: limit.sensitivity.min,
          sensitivityMax: limit.sensitivity.max,
          selfNoiseLimit: limit.selfNoiseLimit,
        };
      }
    });
    regForm.setFieldsValue({
      code: reg.code,
      name: reg.name,
      agency: reg.agency,
      effectiveFrom: dayjs(reg.effectiveFrom),
      effectiveTo: reg.effectiveTo ? dayjs(reg.effectiveTo) : null,
      status: reg.status,
      remark: reg.remark,
      typeLimits,
    });
    setRegModalOpen(true);
  };

  const submitRegulation = async () => {
    const values = await regForm.validateFields();
    setSubmitting(true);
    try {
      const typeLimits = {} as VerificationRegulation['typeLimits'];
      INSTRUMENT_TYPES.forEach((type) => {
        const limit = values.typeLimits[type];
        typeLimits[type] = {
          sensitivity: { min: Number(limit.sensitivityMin), max: Number(limit.sensitivityMax) },
          selfNoiseLimit: Number(limit.selfNoiseLimit),
        };
      });
      const payload = {
        code: values.code.trim(),
        name: values.name.trim(),
        agency: values.agency.trim(),
        effectiveFrom: values.effectiveFrom ? values.effectiveFrom.format('YYYY-MM-DD') : '',
        effectiveTo: values.effectiveTo ? values.effectiveTo.format('YYYY-MM-DD') : null,
        status: values.status,
        remark: values.remark?.trim() ?? '',
        typeLimits,
      };
      if (editingRegId) {
        await dispatch(updateRegulation({ id: editingRegId, patch: payload })).unwrap();
        message.success('检定规程已更新');
      } else {
        await dispatch(createRegulation(payload)).unwrap();
        message.success('检定规程已录入');
      }
      setRegModalOpen(false);
      // 规程换版后，待重判标定按新版重判
      await dispatch(rejudgePending()).unwrap();
    } finally {
      setSubmitting(false);
    }
  };

  const handleInvalidate = async (reg: VerificationRegulation) => {
    const effectiveTo = dayjs().format('YYYY-MM-DD');
    await dispatch(invalidateRegulation({ id: reg.id, effectiveTo })).unwrap();
    message.success(`规程「${reg.code}」已作废，待重判标定已按新版重判`);
  };

  /* ------------------------------ 批次操作 ------------------------------ */

  const openCreateBatch = () => {
    setEditingBatchId(null);
    batchForm.setFieldsValue({
      code: '',
      date: dayjs(),
      remark: '',
    });
    setBatchModalOpen(true);
  };

  const openEditBatch = (batch: CalibrationBatch) => {
    setEditingBatchId(batch.id);
    batchForm.setFieldsValue({
      code: batch.code,
      date: dayjs(batch.date),
      remark: batch.remark,
    });
    setBatchModalOpen(true);
  };

  const submitBatch = async () => {
    const values = await batchForm.validateFields();
    setSubmitting(true);
    try {
      const payload = {
        code: values.code.trim(),
        date: values.date ? values.date.format('YYYY-MM-DD') : '',
        remark: values.remark?.trim() ?? '',
      };
      if (editingBatchId) {
        await dispatch(updateBatch({ id: editingBatchId, patch: payload })).unwrap();
        message.success('批次已更新');
      } else {
        await dispatch(createBatch(payload)).unwrap();
        message.success('批次已创建');
      }
      setBatchModalOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  /* ------------------------------ 对账操作 ------------------------------ */

  const reconciliationCounts = useMemo(() => {
    const counts: Record<ReconcileStatus, number> = { 一致: 0, 不一致: 0, 无规程: 0, 未记录: 0 };
    reconciliation.forEach((item) => {
      counts[item.status] += 1;
    });
    return counts;
  }, [reconciliation]);

  const instrumentIndex = useMemo(() => {
    const map = new Map<string, string>();
    instruments.forEach((ins) => {
      map.set(ins.id, `${ins.model}（${ins.serialNo}）`);
    });
    return map;
  }, [instruments]);

  const handleRejudge = async (calibrationId: string) => {
    const result = await dispatch(rejudgeCalibration(calibrationId)).unwrap();
    if (result.rejudged) {
      message.success(`已按 ${result.verdict ?? ''} 重判`);
    } else {
      message.warning('重判失败：标定日期无生效规程，只读保留');
    }
  };

  const handleRejudgeAll = async () => {
    const result = await dispatch(rejudgePending()).unwrap();
    message.success(`待重判 ${result.total} 条，已重判 ${result.rejudged} 条`);
  };

  /* ------------------------------ 渲染 ------------------------------ */

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            检定规程与对账
          </Typography.Title>
          <p className="gb-hint">
            计量站维护检定规程（规程号、生效起止、类型区间）；台网中心按标定当天生效的规程定响应结论，同趟出车落在同版。
            两边按规程号和标定日期对账，对不上的单列。
          </p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void initDatabase()}>
            补齐演示数据
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => void handleRejudgeAll()}>
            全部重判
          </Button>
        </Space>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="检定规程" value={regulations.length} suffix="版" tone="primary" />
        <StatBadge label="标定批次" value={batches.length} suffix="批" tone="info" />
        <StatBadge label="对账一致" value={reconciliationCounts.一致} suffix="条" tone="success" />
        <StatBadge
          label="对不上"
          value={reconciliationCounts.不一致 + reconciliationCounts.无规程 + reconciliationCounts.未记录}
          suffix="条"
          tone="danger"
        />
        <StatBadge label="待重判" value={pendingRejudgeCount} suffix="条" tone="warning" />
      </div>

      {pendingRejudgeCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          message={`有 ${pendingRejudgeCount} 条标定没出结论，规程换版后先挂着按新版重判`}
          action={
            <Button size="small" type="primary" onClick={() => void handleRejudgeAll()}>
              全部重判
            </Button>
          }
        />
      ) : null}

      <Tabs
        items={[
          {
            key: 'regulations',
            label: (
              <span>
                <SafetyCertificateOutlined /> 检定规程
              </span>
            ),
            children: (
              <Card
                className="gb-panel"
                size="small"
                title="检定规程版本"
                extra={
                  <Button type="primary" icon={<PlusOutlined />} onClick={openCreateRegulation}>
                    新增规程
                  </Button>
                }
              >
                {regulations.length === 0 ? (
                  <EmptyPanel
                    title="还没有检定规程"
                    description="点击「新增规程」录入计量站发布的检定规程版本。"
                    actionText="新增规程"
                    onAction={openCreateRegulation}
                  />
                ) : (
                  <Table
                    rowKey="id"
                    size="small"
                    className="gb-table-compact"
                    dataSource={regulations}
                    pagination={false}
                    columns={[
                      {
                        title: '规程号',
                        dataIndex: 'code',
                        width: 140,
                        render: (value: string, row) => (
                          <Space direction="vertical" size={0}>
                            <span className="gb-mono" style={{ fontWeight: 600 }}>
                              {value}
                            </span>
                            <Tag color={row.status === '现行' ? 'green' : 'default'}>{row.status}</Tag>
                          </Space>
                        ),
                      },
                      { title: '规程名称', dataIndex: 'name', ellipsis: true },
                      { title: '发布机构', dataIndex: 'agency', width: 160 },
                      {
                        title: '生效起止',
                        width: 200,
                        render: (_: unknown, row) => (
                          <span className="gb-mono">
                            {row.effectiveFrom} ~ {row.effectiveTo ?? '至今'}
                          </span>
                        ),
                      },
                      {
                        title: '类型区间（灵敏度 / 自噪上限）',
                        render: (_: unknown, row) => (
                          <Space size={4} wrap>
                            {INSTRUMENT_TYPES.map((type) => {
                              const limit = row.typeLimits[type];
                              return (
                                <Tag key={type}>
                                  {type} {limit.sensitivity.min}~{limit.sensitivity.max} / 噪 ≤ {limit.selfNoiseLimit}
                                </Tag>
                              );
                            })}
                          </Space>
                        ),
                      },
                      {
                        title: '操作',
                        width: 200,
                        render: (_: unknown, row) => (
                          <Space size={6}>
                            <Button size="small" icon={<EditOutlined />} onClick={() => openEditRegulation(row)}>
                              编辑
                            </Button>
                            {row.status === '现行' ? (
                              <Popconfirm
                                title="作废规程"
                                description={`确认作废「${row.code}」？作废后待重判标定按新版重判。`}
                                okText="作废"
                                cancelText="取消"
                                onConfirm={() => void handleInvalidate(row)}
                              >
                                <Button size="small">作废</Button>
                              </Popconfirm>
                            ) : null}
                            <Popconfirm
                              title="删除规程"
                              description={`确认删除「${row.code}」？`}
                              okText="删除"
                              cancelText="取消"
                              okButtonProps={{ danger: true }}
                              onConfirm={() =>
                                void dispatch(removeRegulation(row.id)).then(() =>
                                  message.success('规程已删除')
                                )
                              }
                            >
                              <Button size="small" danger icon={<CloseCircleOutlined />}>
                                删除
                              </Button>
                            </Popconfirm>
                          </Space>
                        ),
                      },
                    ]}
                  />
                )}
              </Card>
            ),
          },
          {
            key: 'batches',
            label: (
              <span>
                <SafetyCertificateOutlined /> 标定批次
              </span>
            ),
            children: (
              <Card
                className="gb-panel"
                size="small"
                title="标定批次（同趟出车）"
                extra={
                  <Button type="primary" icon={<PlusOutlined />} onClick={openCreateBatch}>
                    新增批次
                  </Button>
                }
              >
                {batches.length === 0 ? (
                  <EmptyPanel
                    title="还没有标定批次"
                    description="点击「新增批次」登记同趟出车的标定批次，批次日期决定规程版本。"
                    actionText="新增批次"
                    onAction={openCreateBatch}
                  />
                ) : (
                  <Table
                    rowKey="id"
                    size="small"
                    className="gb-table-compact"
                    dataSource={batches}
                    pagination={false}
                    columns={[
                      { title: '批次号', dataIndex: 'code', width: 140, render: (v: string) => <span className="gb-mono">{v}</span> },
                      { title: '出车日期', dataIndex: 'date', width: 120, className: 'gb-mono' },
                      {
                        title: '依据规程号',
                        dataIndex: 'regulationCode',
                        width: 160,
                        render: (v: string) => <span className="gb-mono">{v || '—'}</span>,
                      },
                      { title: '备注', dataIndex: 'remark', ellipsis: true },
                      {
                        title: '操作',
                        width: 160,
                        render: (_: unknown, row) => (
                          <Space size={6}>
                            <Button size="small" icon={<EditOutlined />} onClick={() => openEditBatch(row)}>
                              编辑
                            </Button>
                            <Popconfirm
                              title="删除批次"
                              description="确认删除该批次？批次下标定记录将变为未归批次。"
                              okText="删除"
                              cancelText="取消"
                              okButtonProps={{ danger: true }}
                              onConfirm={() =>
                                void dispatch(removeBatch(row.id)).then(() => message.success('批次已删除'))
                              }
                            >
                              <Button size="small" danger icon={<CloseCircleOutlined />}>
                                删除
                              </Button>
                            </Popconfirm>
                          </Space>
                        ),
                      },
                    ]}
                  />
                )}
              </Card>
            ),
          },
          {
            key: 'reconciliation',
            label: (
              <span>
                <SafetyCertificateOutlined /> 对账
                {reconciliationCounts.不一致 + reconciliationCounts.无规程 + reconciliationCounts.未记录 > 0 ? (
                  <Tag color="danger" style={{ marginLeft: 6 }}>
                    {reconciliationCounts.不一致 + reconciliationCounts.无规程 + reconciliationCounts.未记录}
                  </Tag>
                ) : null}
              </span>
            ),
            children: (
              <Card
                className="gb-panel"
                size="small"
                title="标定记录与规程对账"
                extra={
                  <Space>
                    <Tag color="green">一致 {reconciliationCounts.一致}</Tag>
                    <Tag color="red">不一致 {reconciliationCounts.不一致}</Tag>
                    <Tag>无规程 {reconciliationCounts.无规程}</Tag>
                    <Tag>未记录 {reconciliationCounts.未记录}</Tag>
                  </Space>
                }
              >
                {reconciliation.length === 0 ? (
                  <EmptyPanel
                    title="还没有标定记录"
                    description="先到「标定记录台」录入标定记录，再回到本页对账。"
                  />
                ) : (
                  <Table
                    rowKey="calibrationId"
                    size="small"
                    className="gb-table-compact"
                    dataSource={reconciliation}
                    pagination={{ pageSize: 12, showSizeChanger: false }}
                    rowClassName={(row) => (row.status !== '一致' ? 'gb-row-danger' : '')}
                    columns={[
                      {
                        title: '仪器',
                        width: 200,
                        render: (_: unknown, row) => instrumentIndex.get(row.instrumentId) ?? '仪器已删除',
                      },
                      { title: '标定日期', dataIndex: 'calibrationDate', width: 120, className: 'gb-mono' },
                      {
                        title: '记录规程号',
                        dataIndex: 'recordedRegulationCode',
                        width: 160,
                        render: (v: string) => <span className="gb-mono">{v || '—'}</span>,
                      },
                      {
                        title: '日期对应规程号',
                        dataIndex: 'effectiveRegulationCode',
                        width: 160,
                        render: (v: string | null) => <span className="gb-mono">{v ?? '—'}</span>,
                      },
                      {
                        title: '对账状态',
                        width: 110,
                        render: (_: unknown, row) => {
                          const color =
                            row.status === '一致'
                              ? 'green'
                              : row.status === '不一致'
                                ? 'red'
                                : 'default';
                          return <Tag color={color}>{row.status}</Tag>;
                        },
                      },
                      {
                        title: '结论',
                        width: 120,
                        render: (_: unknown, row) => (
                          <QualifyTag verdict={row.verdict} size="small" />
                        ),
                      },
                      {
                        title: '操作',
                        width: 120,
                        render: (_: unknown, row) =>
                          row.status !== '一致' ? (
                            <Button size="small" type="primary" onClick={() => void handleRejudge(row.calibrationId)}>
                              重判
                            </Button>
                          ) : (
                            <CheckCircleOutlined style={{ color: '#1e8449' }} />
                          ),
                      },
                    ]}
                  />
                )}
              </Card>
            ),
          },
        ]}
      />

      {/* 规程编辑弹窗 */}
      <Modal
        open={regModalOpen}
        title={editingRegId ? '编辑检定规程' : '新增检定规程'}
        onCancel={() => setRegModalOpen(false)}
        onOk={() => void submitRegulation()}
        confirmLoading={submitting}
        okText={editingRegId ? '保存修改' : '保存'}
        width={720}
        destroyOnClose
      >
        <Form form={regForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="code" label="规程号" rules={[{ required: true, message: '请填写规程号' }]}>
                <Input maxLength={40} placeholder="如 JJG 101-2023" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="name" label="规程名称" rules={[{ required: true, message: '请填写规程名称' }]}>
                <Input maxLength={60} placeholder="如 地震台站仪器检定规程（2023 版）" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="agency" label="发布机构" rules={[{ required: true, message: '请填写发布机构' }]}>
                <Input maxLength={40} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="status" label="状态" rules={[{ required: true }]}>
                <Select options={REGULATION_STATUSES.map((s) => ({ label: s, value: s }))} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="effectiveFrom" label="生效起始" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="effectiveTo" label="生效截止（留空为现行）">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Typography.Text strong>各类型灵敏度区间与自噪上限</Typography.Text>
          {INSTRUMENT_TYPES.map((type) => (
            <Row key={type} gutter={12} style={{ marginTop: 8 }}>
              <Col span={4}>
                <Tag style={{ marginTop: 8 }}>{type}</Tag>
              </Col>
              <Col span={7}>
                <Form.Item name={['typeLimits', type, 'sensitivityMin']} label="灵敏度下限">
                  <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={7}>
                <Form.Item name={['typeLimits', type, 'sensitivityMax']} label="灵敏度上限">
                  <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item name={['typeLimits', type, 'selfNoiseLimit']} label="自噪上限">
                  <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>
          ))}
          <Form.Item name="remark" label="备注" style={{ marginTop: 12 }}>
            <Input.TextArea rows={2} maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 批次编辑弹窗 */}
      <Modal
        open={batchModalOpen}
        title={editingBatchId ? '编辑标定批次' : '新增标定批次'}
        onCancel={() => setBatchModalOpen(false)}
        onOk={() => void submitBatch()}
        confirmLoading={submitting}
        okText={editingBatchId ? '保存修改' : '保存'}
        width={520}
        destroyOnClose
      >
        <Form form={batchForm} layout="vertical" preserve={false}>
          <Form.Item name="code" label="批次号 / 趟次" rules={[{ required: true, message: '请填写批次号' }]}>
            <Input maxLength={40} placeholder="如 2024 春巡" />
          </Form.Item>
          <Form.Item name="date" label="出车日期" rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
