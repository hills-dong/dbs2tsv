# DBS + PayLah 账单转换工具 - 技术规格说明书 (v2.1)

本文档定义了 `dbs2tsv` 项目的技术实现规范，包括 DBS 解析、PayLah 集成、匹配算法及 UI 设计要求。

## 1. 项目愿景
打造一个**完全本地化**、**隐私安全**且**智能**的个人财务工具，不仅能解析 DBS 银行账单，还能通过整合 PayLah! 数据，解决银行账单中 "TOP-UP" 记录缺乏细节的痛点，为用户提供清晰的每一笔消费去向。

---

## 2. 核心功能需求

### 2.1 DBS 账单解析 (Core)
- **输入**：DBS Bank eStatement (PDF)。
- **解析逻辑**：基于 `pdf.js` 获取文本项坐标 `(x, y)`。
- **关键规则**：
    - 仅解析 `Balance Brought Forward` 与 `Balance Carried Forward` 之间的区域。
    - **日期识别**：x < 90 pt 且符合 `DD/MM/YYYY` 或 `DD Mon` 格式。
    - **跨行合并**：同一交易的 Description 如果分多行显示，必须合并。
    - **列映射**：严格遵循 X 坐标阈值区分 Debit/Credit/Balance。
    - **多货币支持**：自动检测 SGD/USD 账户，通过 `SGD ` 或 `USD ` 前缀识别。

### 2.2 PayLah! 账单集成 (Feature)
- **输入**：DBS PayLah! eStatement (PDF)。支持**批量上传**。
- **解析逻辑**：
    - **日期解析**：基于 `STATEMENT DATE` 自动推断年份。
        - 逻辑：若交易月份 > Statement 月份（如 1月账单出现 12月交易），年份 = `StatementYear - 1`。
    - **正则提取**：使用正则 `^(\d{1,2}\s[A-Za-z]{3})\s+(.+?)\s+(\d{1,3}(?:,\d{3})*\.\d{2}(?:\s*[CD][RB])?)$` 提取单行记录。
    - **类型判断**：
        - 以 `CR` 结尾 = 收入 (Credit)
        - 以 `DB` 结尾 = 支出 (Debit)
        - 描述包含 `top-up` 或 `received` = 收入

### 2.3 智能匹配算法 (Algorithm)
- **目标**：将 DBS 账单中的 `TOP-UP TO PAYLAH!` 替换为 PayLah 账单中的实际商家名称。
- **触发时机**：每次上传 DBS 或 PayLah 文件后自动触发。
- **匹配规则**：
    1. 遍历 DBS 交易，找到 Description 包含 `TOP-UP TO PAYLAH!` 的支出(`Debit`)记录。
    2. 在 PayLah 记录池中寻找匹配项，条件：
       - `PayLah.Date == DBS.Date` 或 `PayLah.Date == DBS.Date + 1天`
       - `abs(PayLah.Amount - DBS.Debit) < 0.01` (浮点容差)
       - `PayLah.Type == 'DB'` (必须是 PayLah 支出记录)
       - `PayLah.matchId == null` (未被匹配过)
    3. **命中处理**：
       - 更新 DBS 记录：`Description = "[PayLah] " + PayLah.Description`
       - 标记匹配：双方记录设置相同的 `matchId`
    4. **未命中处理**：保持原样，UI 中显示红色提示。

### 2.4 数据导出
- **格式**：TSV (Tab-Separated Values)。
- **列序**：`日期 | 描述 | 支出 | 收入 | 余额 | 货币`。
- **兼容性**：直接粘贴至 Excel/Numbers/Notion 表格。

---

## 3. UI/UX 设计规范

### 3.1 风格指南 (Douban Style)
- **核心理念**：极简、内容为王、无干扰。
- **配色**：
    - 主色调：`#3377aa` (豆瓣蓝)
    - 背景色：`#ffffff` (纯白) / `#f0f3f5` (淡灰背景)
    - 文字：`#111` (主黑) / `#666` (次灰)
- **布局**：
    - **侧边栏 (Sidebar)**：固定宽度 280px，包含所有上传控件和操作按钮。
    - **主内容区 (Main)**：展示状态提示和解析结果表格。

### 3.2 交互规范
- **文件上传**：
    - 必须支持 Drag & Drop。
    - 上传后显示文件名和记录数。
    - 支持重复选择同一文件（需重置 input value）。
- **结果统计**：
    - 显示：银行记录数、PayLah 记录数、匹配数/应匹配数。
- **复制按钮**：
    - 成功复制后，按钮颜色变化并显示 "已复制!"，2秒后恢复。
- **空状态**：
    - 初始状态显示友好的欢迎/引导页面。

---

## 4. 技术栈
- **Core**：原生 HTML5 / CSS3 / ES6+ JavaScript。
- **PDF Engine**：`pdfjs-dist` (v3.11+)。
- **Architecture**：
    - `parser.js`：核心解析模块（可在 Node.js 和浏览器中复用）
    - `app.js`：前端应用逻辑

---

## 5. 测试要求
- 提供自动化测试脚本 (`tests/test-runner.js`)。
- 测试方法：对比解析结果与 `correct_result.tsv` 中的预期值。
- 覆盖场景：
    - DBS 正常解析（76 条记录）。
    - PayLah 正常解析（41 条记录）。
    - Top-Up 匹配逻辑验证（9 条匹配成功）。
    - 多货币支持（SGD + USD）。
