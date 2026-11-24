# E2E 端到端测试（Playwright）

使用 Playwright 对指定功能或页面进行自动化端到端测试。

执行步骤：
1. 确认 Playwright 已安装，若未安装先完成安装（检查 @playwright/test + 浏览器）
2. 了解测试目标：应用 URL、模块名称、核心用户流程
3. 分析页面结构（优先用 getByRole / getByLabel / getByText 定位，避免脆弱 CSS 选择器）
4. 编写测试用例，覆盖：主流程（happy path）+ 关键边界（表单校验、权限拦截、空状态）
5. 运行测试：npx playwright test --reporter=list
6. 失败时：查看截图和 trace，分析根因，修复后重跑
7. 输出测试报告：通过/失败数量 + 覆盖的功能点列表

目标模块或说明：$ARGUMENTS
