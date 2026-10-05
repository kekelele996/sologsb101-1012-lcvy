/**
 * 路由表：
 * - 计量站侧：/regulations（检定规程管理）、/reconciliation（规程对账）
 * - 台网中心侧：/arrays、/stations/:id/instruments、/calibrations、/replacements
 * - 公共：/geometry
 * 页面按路由懒加载，构建时自动分包。
 */
import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { Skeleton } from 'antd';
import App from '@/App';

const ArrayList = lazy(() => import('@/pages/ArrayList'));
const StationInstruments = lazy(() => import('@/pages/StationInstruments'));
const CalibrationBoard = lazy(() => import('@/pages/CalibrationBoard'));
const ReplaceBoard = lazy(() => import('@/pages/ReplaceBoard'));
const GeometryView = lazy(() => import('@/pages/GeometryView'));
const RegulationBoard = lazy(() => import('@/pages/RegulationBoard'));
const ReconciliationBoard = lazy(() => import('@/pages/ReconciliationBoard'));

/** 懒加载页面占位 */
function RouteFallback() {
  return (
    <Skeleton
      active
      paragraph={{ rows: 6 }}
      style={{ background: '#ffffff', padding: 16, borderRadius: 10 }}
    />
  );
}

/** 包裹懒加载页面，避免整页被 Suspense 卸载 */
function withSuspense(node: ReactNode): ReactNode {
  return <Suspense fallback={<RouteFallback />}>{node}</Suspense>;
}

export const ROUTES = {
  regulations: '/regulations',
  reconciliation: '/reconciliation',
  arrays: '/arrays',
  stations: (arrayId: string): string => `/stations/${arrayId}/instruments`,
  calibrations: '/calibrations',
  replacements: '/replacements',
  geometry: '/geometry',
} as const;

export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to={ROUTES.arrays} replace /> },
      { path: 'regulations', element: withSuspense(<RegulationBoard />) },
      { path: 'reconciliation', element: withSuspense(<ReconciliationBoard />) },
      { path: 'arrays', element: withSuspense(<ArrayList />) },
      { path: 'stations/:id/instruments', element: withSuspense(<StationInstruments />) },
      { path: 'calibrations', element: withSuspense(<CalibrationBoard />) },
      { path: 'replacements', element: withSuspense(<ReplaceBoard />) },
      { path: 'geometry', element: withSuspense(<GeometryView />) },
      { path: '*', element: <Navigate to={ROUTES.arrays} replace /> },
    ],
  },
];

export default appRoutes;
