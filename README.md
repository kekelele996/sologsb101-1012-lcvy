# sologsb101-1012 地震台阵仪器标定与布设台账

面向地震台阵建设与运维班组的纯前端单页应用：把台站布设、仪器安装与逐次标定结果写成可追溯的台账。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22812**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22812）。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18.3（函数组件 + Hooks） | 页面全部 `lazy` 懒加载并 `Suspense` 兜底 |
| 语言 | TypeScript 5.6（strict） | 构建脚本执行 `tsc --noEmit` 类型检查 |
| UI 组件 | Ant Design 5.22 + @ant-design/icons | 中文语言包，表格 / 表单 / Modal / 徽标 |
| 构建 | Vite 5 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Redux Toolkit 2 + react-redux 9 | `regulationSlice`（计量站）/ `arraySlice` / `instrumentSlice` / `calibrationSlice` |
| 路由 | React Router 6（`createBrowserRouter`） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbseisarray`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 角色 | 主要交互 |
| --- | --- | --- | --- |
| `/regulations` | 检定规程管理 | 计量站 | 维护规程号、版次、生效起止与各类型灵敏度区间/自噪上限；同规程号发新版自动作废旧版，判据一经标定引用即冻结 |
| `/reconciliation` | 规程对账 | 计量站 × 台网中心 | 按规程号+标定日期两边核对，不符记录单列只读；换版后未出结论的标定在此按现行版重判 |
| `/arrays` | 台阵与台站台账 | 台网中心 | Array、Station、Instrument | 新建/编辑/删除台阵，按布设日期、运行状态与孔径分档筛选；卡片回显台站数、仪器数与标定合格率，可一键按经纬度重算孔径 |
| `/stations/:id/instruments` | 台站仪器登记与安装位置维护 | 台网中心 | Station、Instrument | 新增/编辑/删除台站（经纬度范围校验 + 度分秒显示、基岩类型、高程），登记仪器（类型/型号/序列号**唯一性校验**/安装日期/状态），登记后自动生成下一次标定待办 |
| `/calibrations` | 标定记录台 | 台网中心 | Calibration、Instrument、VerificationRegulation | 按趟次号录入（**同趟出车多台落在同版规程**），按标定当天生效版本自动判灵敏度/自噪结论并固化依据；换版挂起的可重判、对账不符只读、批量手工改结论、灵敏度趋势 |
| `/replacements` | 合格评定与更换提醒 | 台网中心 | Replace、Calibration、Instrument | 按 365 天标定周期评定，超期未标定与不合格仪器高亮；登记更换并推进状态机（待更换→已更换→已复核），流转到「已更换」时回写仪器序列号 |
| `/geometry` | 台阵几何视图与结构版本 | 公共 | 全部模型 | 实算孔径与台站间距、SVG 几何平面图与辐射距离、按台阵汇总标定结论、结构版本查看、全量 JSON 导入导出（含规程表） |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该台阵，页面渲染 `<RouteMissingPanel>` 友好空态（含「返回台阵台账」与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1012/
├── README.md
├── docker-compose.yml          # name: gbseisarray，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx            # Provider + ConfigProvider + RouterProvider
        ├── App.tsx             # 侧边导航（计量站/台网中心分组）+ 顶部上下文条 + 页脚，并启动各表订阅
        ├── types/              # array / station / instrument / calibration / replace / regulation / filter
        ├── stores/             # # regulationSlice（计量站）/ arraySlice / instrumentSlice / calibrationSlice / store.ts
        ├── components/common/  # QualifyTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useCalibHistory
        ├── pages/              # RegulationBoard / ReconciliationBoard / ArrayList / StationInstruments / CalibrationBoard / ReplaceBoard / GeometryView
        ├── router/index.tsx    # 路由表（路径与提示词逐字一致）
        ├── styles/main.css
        └── utils/              # geo.ts（Haversine/孔径）/ db.ts（Dexie 封装+v3 迁移）/ calibration.ts（绑定/重判）/ export.ts（导入导出与结论）
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22812
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbseisarray`，当前结构版本 `v3`。读写统一经 `frontend/src/utils/db.ts` 封装，页面组件不直接触碰 Dexie 实例。
- **数据表**：`regulations`（检定规程，计量站维护）、`arrays`（台阵）、`stations`（台站）、`instruments`（仪器）、`calibrations`（标定，台网中心维护）、`replaces`（更换）。
- **职责边界（规程与标定分家）**：
  - 计量站在 `/regulations` 维护检定规程：规程号（跨版稳定）、版次、生效起止、归口单位与各仪器类型的灵敏度区间/自噪上限。同一规程号发布新版时旧版自动作废（截止日收到新版生效前一天）；已被标定引用的版本判据与生效区间冻结，调整限值必须发新版。
  - 台网中心在 `/calibrations` 维护标定记录：按趟次号（`tripNo`，同一次出车共用）归组，录入时按**规程号 + 标定日期**定位当天生效版本，同趟几台仪器必落同版；判定后把判据固化为 `verdictBasis` 快照（规程号、版次、on-date/current 模式、区间与限值）。
  - 换版或作废后：**未出结论**的标定置 `pendingRejudge` 挂起，可在 `/reconciliation` 按同规程号现行版重判；**已出结论**的照旧保留原结论与依据，列表与报告展示「依据哪版」。
  - 重判失败（无现行版/类型未覆盖/数值异常）只把错误写在本方标定（`judgeError`）并保持挂起，规程一行不动，可反复重试。
  - `/reconciliation` 两边按规程号+标定日期对账：相符、换版重判（note）、对不上账（无规程号/版次缺失/日期不在生效期，`readonlyMismatch` 只读保留）分栏列出。
- **升级迁移**：`db.version(1)`、`db.version(2)` 保留初版与 v2 结构；`db.version(3)` 新增 `regulations` 表与标定的趟次/规程引用/绑定状态/判据快照索引，并灌入规程基线（同规程号 JJG(地震)860 的 2015 版 → 2024 版，区间与自噪上限已调整）。旧标定没记规程号，迁移时按标定日期回填当时生效版本、补趟次号（同日同机构归同趟）并为已出结论记录补判据快照；对不上的（早于最早规程、类型未覆盖）置只读保留。调整字段结构时递增 `DB_VERSION` 并补迁移。
- **首屏播种**：`initDatabase()` 在 `arrays` 表为空时执行幂等播种（2 版规程 / 2 个台阵 / 5 个台站 / 8 台仪器 / 16 条标定 / 3 条更换），刻意包含：同趟出车两台共用趟次号（2024-09-30 HX01）、旧版下的不合格（自噪 4.8 > 3.5，旧版结论保留）、换版后挂起待重判（灵敏度 2780/自噪 3.2，旧版合格、新版不合格）、对不上账只读的早期记录。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，`App.tsx` 挂载时启动订阅并把数据 dispatch 到 Redux slice，页面只读 selector。
- **业务规则**：标定周期 365 天（超期即在更换提醒页高亮）；响应结论**不写死**，一律按标定绑定版本的该类型灵敏度区间与自噪上限判定（基线：2015 版 宽频带 800~3000 / 短周期 100~800 / 强震 0.1~5、自噪≤3.5；2024 版 900~2800 / 120~750 / 0.2~4.5、自噪≤3.0/3.0/2.5），最终以标定报告为准；仪器序列号全局唯一；更换状态机为 待更换 → 已更换 → 已复核，流转到「已更换」时把新序列号回写到仪器档案并置为在用。
- **备份与恢复**：`/geometry` 页可导出包含六张表的 JSON 快照，支持「覆盖导入」与「追加导入（重新分配业务 id，规程保持同 id 以维持对账）」；备份时间写入 `localStorage`，页脚与几何页均展示结构版本号。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。
