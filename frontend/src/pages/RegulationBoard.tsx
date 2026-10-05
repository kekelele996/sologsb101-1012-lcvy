/**
 * 计量站侧：/regulations 检定规程管理
 * 维护规程号、版次、生效起止与各仪器类型的灵敏度区间 / 自噪上限。
 * 同一规程号发布新版时旧版自动作废；判据一旦被标定记录引用即冻结，改限值请发新版。
 */
import { useMemo, useState } from 'react';
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
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined, EditOutlined, StopOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import {
  createRegulation,
  selectRegulations,
  updateRegulation,
  type RegulationDraft,
} from '@/stores/regulationSlice';
import { selectCalibrations } from '@/stores/calibrationSlice';
import { INSTRUMENT_TYPES, type InstrumentType } from '@/types/instrument';
import type { TypeCriterion, VerificationRegulation } from '@/types/regulation';

interface RegulationFormValues {
  regulationCode: string;
  edition: string;
  name: string;
  issuer: string;
  effectiveFrom: dayjs.Dayjs;
  effectiveTo: dayjs.Dayjs | null;
  remark: string;
  criteria: Record<InstrumentType, TypeCriterion | undefined>;
}

function emptyCriterion(sample?: TypeCriterion): TypeCriterion {
  return sample
    ? { sensitivityMin: sample.sensitivityMin, sensitivityMax: sample.sensitivityMax, selfNoiseLimit: sample.selfNoiseLimit }
    : { sensitivityMin: 0, sensitivityMax: 0, selfNoiseLimit: 0 };
}

export default function RegulationBoard() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();
  const regulations = useAppSelector(selectRegulations);
  const calibrations = useAppSelector(selectCalibrations);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<RegulationFormValues>();

  /** 各规程版本被多少标定引用 */
  const referenceCount = useMemo(() => {
    const map = new Map<string, number>();
    calibrations.forEach((row) => {
      if (row.regulationId) map.set(row.regulationId, (map.get(row.regulationId) ?? 0) + 1);
    });
    return map;
  }, [calibrations]);

  const stats = useMemo(() => {
    const codes = new Set(regulations.map((row) => row.regulationCode));
    return {
      editions: regulations.length,
      codeCount: codes.size,
      active: regulations.filter((row) => row.status === '生效中').length,
      voided: regulations.filter((row) => row.status === '已作废').length,
    };
  }, [regulations]);

  const openCreate = (prefillCode?: string) => {
    setEditingId(null);
    const latestOfCode = regulations
      .filter((row) => row.regulationCode === prefillCode)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    form.setFieldsValue({
      regulationCode: prefillCode ?? latestOfCode?.regulationCode ?? 'JJG(地震)860-',
      edition: '',
      name: latestOfCode?.name ?? '地震观测仪器检定规程',
      issuer: latestOfCode?.issuer ?? '省地震局计量站',
      effectiveFrom: dayjs(),
      effectiveTo: null,
      remark: '',
      criteria: INSTRUMENT_TYPES.reduce(
        (acc, type) => {
          acc[type] = emptyCriterion(latestOfCode?.criteria[type]);
          return acc;
        },
        {} as Record<InstrumentType, TypeCriterion | undefined>
      ),
    });
    setModalOpen(true);
  };

  const openEdit = (row: VerificationRegulation) => {
    setEditingId(row.id);
    form.setFieldsValue({
      regulationCode: row.regulationCode,
      edition: row.edition,
      name: row.name,
      issuer: row.issuer,
      effectiveFrom: dayjs(row.effectiveFrom),
      effectiveTo: row.effectiveTo ? dayjs(row.effectiveTo) : null,
      remark: row.remark,
      criteria: INSTRUMENT_TYPES.reduce(
        (acc, type) => {
          acc[type] = row.criteria[type] ? { ...row.criteria[type]! } : undefined;
          return acc;
        },
        {} as Record<InstrumentType, TypeCriterion | undefined>
      ),
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    const criteria = {} as Partial<Record<InstrumentType, TypeCriterion>>;
    INSTRUMENT_TYPES.forEach((type) => {
      const c = values.criteria?.[type];
      if (c && c.sensitivityMax > 0) criteria[type] = { ...c };
    });
    const draft: RegulationDraft = {
      regulationCode: values.regulationCode.trim(),
      edition: values.edition.trim(),
      name: values.name.trim(),
      issuer: values.issuer.trim(),
      effectiveFrom: values.effectiveFrom.format('YYYY-MM-DD'),
      effectiveTo: values.effectiveTo ? values.effectiveTo.format('YYYY-MM-DD') : null,
      criteria,
      remark: values.remark?.trim() ?? '',
    };
    setSubmitting(true);
    try {
      if (editingId) {
        const referenced = (referenceCount.get(editingId) ?? 0) > 0;
        if (referenced) {
          // 已引用：仅名称 / 归口 / 备注可改
          await dispatch(
            updateRegulation({
              id: editingId,
              patch: { name: draft.name, issuer: draft.issuer, remark: draft.remark },
            })
          ).unwrap();
          message.success('该版已被标定引用，判据与生效区间冻结，仅更新名称 / 归口 / 备注');
        } else {
          await dispatch(updateRegulation({ id: editingId, patch: draft })).unwrap();
          message.success('规程版本已更新');
        }
      } else {
        const result = await dispatch(createRegulation(draft)).unwrap();
        message.success(
          result.pendingCount > 0
            ? `新版已生效，旧版作废，${result.pendingCount} 条未出结论标定已挂起到「规程对账」按新版重判`
            : '新版规程已登记生效'
        );
      }
      setModalOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleVoid = async (row: VerificationRegulation) => {
    await dispatch(updateRegulation({ id: row.id, patch: {}, status: '已作废' })).unwrap();
    message.success(`已将 ${row.regulationCode} ${row.edition} 置为作废，未出结论标定挂起重判`);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            检定规程管理（计量站）
          </Typography.Title>
          <p className="gb-hint">
            维护规程号、版次、生效起止与各类型灵敏度区间 / 自噪上限；同规程号发新版自动作废旧版，
            台网中心未出结论的标定挂起按新版重判，已出结论照旧保留。
          </p>
        </div>
        <Space wrap>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>
            登记规程版本
          </Button>
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        message="职责边界：本页仅计量站维护检定规程；台网中心在「标定记录台」按标定当天生效版本判定，不允许在标定侧改区间。已被标定引用的版本判据冻结，调整限值必须发布新版。"
      />

      <div className="gb-stats-row">
        <StatBadge label="规程号" value={stats.codeCount} suffix="套" tone="primary" />
        <StatBadge label="版本总数" value={stats.editions} suffix="版" tone="info" />
        <StatBadge label="生效中" value={stats.active} suffix="版" tone="success" />
        <StatBadge label="已作废" value={stats.voided} suffix="版" tone="warning" />
      </div>

      {regulations.length === 0 ? (
        <EmptyPanel
          title="还没有检定规程"
          description="计量站先登记规程号、版次、生效起止与各类型判据，台网中心才能按当天生效版本出具标定结论。"
          actionText="登记规程版本"
          onAction={() => openCreate()}
        />
      ) : (
        <Table
          rowKey="id"
          className="gb-table-compact"
          dataSource={[...regulations].sort((a, b) =>
            `${a.regulationCode}${b.effectiveFrom}`.localeCompare(`${b.regulationCode}${a.effectiveFrom}`)
          )}
          pagination={false}
          expandable={{
            expandedRowRender: (row) => (
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <div className="gb-hint">
                  {row.name} · {row.issuer}
                  {row.remark ? ` · ${row.remark}` : ''}
                </div>
                <Table
                  rowKey={(item) => item[0]}
                  size="small"
                  pagination={false}
                  dataSource={INSTRUMENT_TYPES.filter((type) => row.criteria[type]).map((type) => [type, row.criteria[type]!] as const)}
                  columns={[
                    { title: '仪器类型', dataIndex: '0', width: 120 },
                    {
                      title: '灵敏度区间 (V·s/m)',
                      render: (_: unknown, item: readonly [string, TypeCriterion]) => (
                        <span className="gb-mono">
                          {item[1].sensitivityMin} ~ {item[1].sensitivityMax}
                        </span>
                      ),
                    },
                    {
                      title: '自噪上限',
                      render: (_: unknown, item: readonly [string, TypeCriterion]) => (
                        <span className="gb-mono">{item[1].selfNoiseLimit}</span>
                      ),
                    },
                  ]}
                />
              </Space>
            ),
          }}
          columns={[
            {
              title: '规程号',
              width: 200,
              render: (_: unknown, row: VerificationRegulation) => (
                <div>
                  <div className="gb-mono" style={{ fontWeight: 600 }}>{row.regulationCode}</div>
                  <div className="gb-hint">{row.name}</div>
                </div>
              ),
            },
            { title: '版次', dataIndex: 'edition', width: 110 },
            {
              title: '生效起止',
              width: 210,
              render: (_: unknown, row: VerificationRegulation) => (
                <span className="gb-mono">
                  {row.effectiveFrom} ~ {row.effectiveTo ?? '至今'}
                </span>
              ),
            },
            { title: '归口单位', dataIndex: 'issuer', width: 170 },
            {
              title: '状态',
              width: 100,
              render: (_: unknown, row: VerificationRegulation) => (
                <Tag color={row.status === '生效中' ? 'green' : 'default'}>{row.status}</Tag>
              ),
            },
            {
              title: '标定引用',
              width: 100,
              align: 'right',
              render: (_: unknown, row: VerificationRegulation) => (
                <Tag color={referenceCount.get(row.id) ? 'blue' : 'default'}>
                  {referenceCount.get(row.id) ?? 0} 条
                </Tag>
              ),
            },
            {
              title: '类型判据',
              render: (_: unknown, row: VerificationRegulation) => (
                <Space size={4} wrap>
                  {INSTRUMENT_TYPES.map((type) => {
                    const c = row.criteria[type];
                    return c ? (
                      <Tag key={type}>
                        {type} {c.sensitivityMin}~{c.sensitivityMax} / 噪≤{c.selfNoiseLimit}
                      </Tag>
                    ) : (
                      <Tag key={type} color="default">
                        {type} 未覆盖
                      </Tag>
                    );
                  })}
                </Space>
              ),
            },
            {
              title: '操作',
              width: 210,
              render: (_: unknown, row: VerificationRegulation) => {
                const referenced = (referenceCount.get(row.id) ?? 0) > 0;
                return (
                  <Space size={6}>
                    <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
                      {referenced ? '改文案' : '编辑'}
                    </Button>
                    {row.status === '生效中' ? (
                      <Popconfirm
                        title="作废该规程版本"
                        description="未出结论且引用该版的标定将挂起按新版重判；已出结论的照旧保留。确认作废？"
                        okText="作废"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => void handleVoid(row)}
                      >
                        <Button size="small" danger icon={<StopOutlined />}>
                          作废
                        </Button>
                      </Popconfirm>
                    ) : (
                      <Button size="small" onClick={() => openCreate(row.regulationCode)}>
                        发新版
                      </Button>
                    )}
                    {row.status === '生效中' ? (
                      <Button size="small" type="link" onClick={() => openCreate(row.regulationCode)}>
                        换版
                      </Button>
                    ) : null}
                  </Space>
                );
              },
            },
          ]}
        />
      )}

      <Modal
        open={modalOpen}
        title={editingId ? '编辑规程版本' : '登记规程版本（换版）'}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        confirmLoading={submitting}
        okText={editingId ? '保存' : '登记并作废旧版'}
        width={760}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                name="regulationCode"
                label="规程号"
                rules={[{ required: true, message: '请填写规程号，换版保持不变' }]}
              >
                <Input maxLength={40} placeholder="如：JJG(地震)860-2024" disabled={!!editingId} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="edition" label="版次" rules={[{ required: true, message: '请填写版次' }]}>
                <Input maxLength={20} placeholder="如：2024 版" disabled={!!editingId} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="name" label="规程名称" rules={[{ required: true }]}>
                <Input maxLength={60} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="issuer" label="归口 / 发布单位">
                <Input maxLength={40} placeholder="如：省地震局计量站" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="effectiveFrom" label="生效起始日" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} disabled={!!editingId} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="effectiveTo" label="生效截止日（留空为长期有效）">
                <DatePicker style={{ width: '100%' }} disabled={!!editingId} />
              </Form.Item>
            </Col>
          </Row>

          <Typography.Text strong>各仪器类型判据（灵敏度区间 + 自噪上限）</Typography.Text>
          <Card size="small" style={{ marginTop: 8, marginBottom: 12 }}>
            {INSTRUMENT_TYPES.map((type) => (
              <Row gutter={12} key={type} align="middle" style={{ marginBottom: 8 }}>
                <Col span={5}>
                  <Tag>{type}</Tag>
                </Col>
                <Col span={6}>
                  <Form.Item name={['criteria', type, 'sensitivityMin']} label="灵敏度下限" style={{ marginBottom: 0 }}>
                    <InputNumber min={0} step={0.01} style={{ width: '100%' }} disabled={!!editingId} />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name={['criteria', type, 'sensitivityMax']} label="灵敏度上限" style={{ marginBottom: 0 }}>
                    <InputNumber min={0} step={0.01} style={{ width: '100%' }} disabled={!!editingId} />
                  </Form.Item>
                </Col>
                <Col span={7}>
                  <Form.Item name={['criteria', type, 'selfNoiseLimit']} label="自噪上限" style={{ marginBottom: 0 }}>
                    <InputNumber min={0} step={0.01} style={{ width: '100%' }} disabled={!!editingId} />
                  </Form.Item>
                </Col>
              </Row>
            ))}
            <p className="gb-hint" style={{ marginBottom: 0 }}>
              上限填 0 视为该版不覆盖该类型；被标定引用的版本判据冻结，需要调整请发新版。
            </p>
          </Card>

          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={120} placeholder="如：换版后灵敏度区间收窄、自噪上限下调" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
