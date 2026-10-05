/**
 * 计量站 × 台网中心：/reconciliation 规程对账
 * 两边按规程号与标定日期核对：
 * - 相符：标定引用的规程号 / 版次存在且标定日期落在生效窗口；
 * - 换版重判（备注）：标定日不在所引新版窗口，但系换版后按现行版重判出结论；
 * - 不符：无规程号 / 规程或版次缺失 / 日期对不上，单列、只读保留。
 * 待重判标定可在此一键按新版重判；重判失败只重试本方标定，规程不动。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { ReloadOutlined, FileSearchOutlined, CheckCircleOutlined } from '@ant-design/icons';
import StatBadge from '@/components/common/StatBadge';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectRegulations } from '@/stores/regulationSlice';
import {
  rejudgeCalibration,
  rejudgeCalibrations,
  selectCalibrations,
} from '@/stores/calibrationSlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import { selectStations, selectArrays } from '@/stores/arraySlice';
import { reconcileCalibration, basisText } from '@/types/regulation';
import type { Calibration } from '@/types/calibration';
import { ROUTES } from '@/router';

interface Row {
  calibration: Calibration;
  instrumentModel: string;
  instrumentType: string;
  serialNo: string;
  stationCode: string;
  arrayName: string;
  status: 'matched' | 'note' | 'mismatch';
  reason: string;
}

export default function ReconciliationBoard() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const regulations = useAppSelector(selectRegulations);
  const calibrations = useAppSelector(selectCalibrations);
  const instruments = useAppSelector(selectInstruments);
  const stations = useAppSelector(selectStations);
  const arrays = useAppSelector(selectArrays);
  const [busy, setBusy] = useState(false);

  const regulationsById = useMemo(
    () => new Map(regulations.map((row) => [row.id, row] as const)),
    [regulations]
  );

  const rows = useMemo<Row[]>(() => {
    return calibrations
      .map((calibration) => {
        const instrument = instruments.find((item) => item.id === calibration.instrumentId);
        const station = instrument
          ? stations.find((item) => item.id === instrument.stationId)
          : undefined;
        const array = station ? arrays.find((item) => item.id === station.arrayId) : undefined;
        const item = reconcileCalibration(calibration, regulationsById);
        return {
          calibration,
          instrumentModel: instrument?.model ?? '仪器已删除',
          instrumentType: instrument?.type ?? '未知',
          serialNo: instrument?.serialNo ?? '—',
          stationCode: station?.code ?? '—',
          arrayName: array?.name ?? '—',
          status: item.status,
          reason: item.reason,
        };
      })
      .sort((a, b) => {
        const rank = { mismatch: 0, note: 1, matched: 2 } as const;
        if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
        return b.calibration.date.localeCompare(a.calibration.date);
      });
  }, [arrays, calibrations, instruments, regulationsById, stations]);

  const mismatches = rows.filter((row) => row.status === 'mismatch');
  const notes = rows.filter((row) => row.status === 'note');
  const matched = rows.filter((row) => row.status === 'matched');
  const pendingRejudge = rows.filter((row) => row.calibration.bindStatus === 'pendingRejudge');

  const handleRejudgeOne = async (id: string) => {
    setBusy(true);
    try {
      const result = await dispatch(rejudgeCalibration(id)).unwrap();
      if (result.bindStatus === 'bound') {
        message.success(`已按现行版重判：结论「${result.responseVerdict}」，依据已固化`);
      } else {
        message.warning(result.judgeError || '仍不具备重判条件，继续挂起（规程未改动）');
      }
    } catch (error) {
      message.error(typeof error === 'string' ? error : '重判失败');
    } finally {
      setBusy(false);
    }
  };

  const handleRejudgeAll = async () => {
    if (pendingRejudge.length === 0) {
      message.info('当前没有待重判标定');
      return;
    }
    setBusy(true);
    try {
      const result = await dispatch(
        rejudgeCalibrations(pendingRejudge.map((row) => row.calibration.id))
      ).unwrap();
      message.success(`重判完成：成功 ${result.succeeded} 条，仍挂起 ${result.failed} 条（规程未改动）`);
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    {
      title: '仪器',
      width: 210,
      render: (_: unknown, row: Row) => (
        <div>
          <div>
            {row.instrumentModel} <Tag>{row.instrumentType}</Tag>
          </div>
          <div className="gb-hint gb-mono">{row.serialNo}</div>
        </div>
      ),
    },
    {
      title: '台站 / 台阵',
      width: 160,
      render: (_: unknown, row: Row) => (
        <div>
          <div className="gb-mono">{row.stationCode}</div>
          <div className="gb-hint">{row.arrayName}</div>
        </div>
      ),
    },
    { title: '标定日期', width: 110, render: (_: unknown, row: Row) => <span className="gb-mono">{row.calibration.date}</span> },
    { title: '趟次号', width: 170, render: (_: unknown, row: Row) => <span className="gb-mono">{row.calibration.tripNo}</span> },
    {
      title: '记录规程号 / 依据',
      width: 260,
      render: (_: unknown, row: Row) => (
        <div>
          <div className="gb-mono">{row.calibration.regulationCode || '（空）'}</div>
          <div className="gb-hint">依据：{basisText(row.calibration.verdictBasis)}</div>
        </div>
      ),
    },
    {
      title: '结论 / 绑定',
      width: 150,
      render: (_: unknown, row: Row) => (
        <Space direction="vertical" size={2}>
          <Tag color={row.calibration.responseVerdict === '合格' ? 'green' : row.calibration.responseVerdict === '不合格' ? 'red' : 'default'}>
            {row.calibration.responseVerdict}
          </Tag>
          {row.calibration.bindStatus === 'pendingRejudge' ? <Tag color="orange">待重判</Tag> : null}
          {row.calibration.bindStatus === 'readonlyMismatch' ? <Tag color="default">只读保留</Tag> : null}
        </Space>
      ),
    },
    { title: '对账说明', render: (_: unknown, row: Row) => <span className={row.status === 'mismatch' ? 'gb-danger' : 'gb-hint'}>{row.reason}</span> },
    {
      title: '操作',
      width: 130,
      render: (_: unknown, row: Row) =>
        row.calibration.bindStatus === 'pendingRejudge' ? (
          <Button
            size="small"
            type="primary"
            icon={<ReloadOutlined />}
            loading={busy}
            onClick={() => void handleRejudgeOne(row.calibration.id)}
          >
            按新版重判
          </Button>
        ) : (
          <span className="gb-hint">—</span>
        ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            规程对账（计量站 × 台网中心）
          </Typography.Title>
          <p className="gb-hint">
            按规程号与标定日期核对两边数据；同趟出车的标定应落在同一版规程。
            对不上账的记录单列只读；换版后挂起的未决标定在此按现行版重判。
          </p>
        </div>
        <Space wrap>
          <Button
            icon={<ReloadOutlined />}
            loading={busy}
            disabled={pendingRejudge.length === 0}
            onClick={() => void handleRejudgeAll()}
          >
            全部待重判按新版重试（{pendingRejudge.length}）
          </Button>
          <Button onClick={() => navigate(ROUTES.regulations)}>维护检定规程</Button>
          <Button type="primary" onClick={() => navigate(ROUTES.calibrations)}>
            去标定记录台
          </Button>
        </Space>
      </div>

      {pendingRejudge.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${pendingRejudge.length} 条标定因规程换版 / 作废尚未出结论，已挂起。可按同规程号现行版重判；重判失败只重试标定记录，规程不动。`}
        />
      ) : null}
      {mismatches.length > 0 ? (
        <Alert
          type="error"
          showIcon
          message={`有 ${mismatches.length} 条标定与规程台账对不上（缺规程号 / 版次缺失 / 日期不在生效期），已单列并置为只读保留。`}
        />
      ) : null}

      <div className="gb-stats-row">
        <StatBadge label="对账标定" value={rows.length} suffix="条" tone="primary" />
        <StatBadge label="相符" value={matched.length} suffix="条" tone="success" />
        <StatBadge label="换版重判" value={notes.length} suffix="条" tone="info" />
        <StatBadge label="待重判" value={pendingRejudge.length} suffix="条" tone="warning" />
        <StatBadge label="不符只读" value={mismatches.length} suffix="条" tone="danger" />
      </div>

      <Card className="gb-panel" size="small">
        <Tabs
          defaultActiveKey="mismatch"
          items={[
            {
              key: 'mismatch',
              label: (
                <span>
                  <FileSearchOutlined /> 对不上账（只读） <Tag color={mismatches.length ? 'red' : 'default'}>{mismatches.length}</Tag>
                </span>
              ),
              children: (
                <Table
                  rowKey={(row) => row.calibration.id}
                  className="gb-table-compact"
                  dataSource={mismatches}
                  columns={columns}
                  pagination={{ pageSize: 10 }}
                  locale={{ emptyText: '没有对不上账的记录，两边规程号与标定日期完全对得上。' }}
                />
              ),
            },
            {
              key: 'pending',
              label: (
                <span>
                  <ReloadOutlined /> 换版待重判 <Tag color={pendingRejudge.length ? 'orange' : 'default'}>{pendingRejudge.length}</Tag>
                </span>
              ),
              children: (
                <>
                  <Space style={{ marginBottom: 10 }}>
                    <Button
                      type="primary"
                      size="small"
                      icon={<ReloadOutlined />}
                      disabled={pendingRejudge.length === 0}
                      loading={busy}
                      onClick={() => void handleRejudgeAll()}
                    >
                      本页全部按现行版重判
                    </Button>
                    <span className="gb-hint">只重试本方标定，任何失败都不改规程。</span>
                  </Space>
                  <Table
                    rowKey={(row) => row.calibration.id}
                    className="gb-table-compact"
                    dataSource={pendingRejudge}
                    columns={columns}
                    pagination={{ pageSize: 10 }}
                    locale={{ emptyText: '没有挂起待重判的标定。' }}
                  />
                </>
              ),
            },
            {
              key: 'note',
              label: (
                <span>
                  换版重判备注 <Tag color={notes.length ? 'blue' : 'default'}>{notes.length}</Tag>
                </span>
              ),
              children: (
                <Table
                  rowKey={(row) => row.calibration.id}
                  className="gb-table-compact"
                  dataSource={notes}
                  columns={columns}
                  pagination={{ pageSize: 10 }}
                  locale={{ emptyText: '暂无换版后按现行版重判的记录。' }}
                />
              ),
            },
            {
              key: 'matched',
              label: (
                <span>
                  <CheckCircleOutlined /> 相符 <Tag color="green">{matched.length}</Tag>
                </span>
              ),
              children: (
                <Table
                  rowKey={(row) => row.calibration.id}
                  className="gb-table-compact"
                  dataSource={matched}
                  columns={columns}
                  pagination={{ pageSize: 10 }}
                />
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
