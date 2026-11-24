# 检查并安装 Playwright

检测当前项目的 Playwright 安装状态，按需完成安装和配置。

执行步骤：
1. 识别包管理器（检查 pnpm-lock.yaml / yarn.lock / package-lock.json）
2. 检查 `@playwright/test` 是否已在 devDependencies 中
3. 若未安装：用检测到的包管理器安装 `@playwright/test`
4. 检查浏览器：运行 `npx playwright install --dry-run`，若缺少则安装 chromium
5. 检查是否有 `playwright.config.{ts,js}`，若无则根据项目框架（Vite/Next/Nuxt 等）生成合适的配置
6. 验证安装：运行一个最简示例测试确认环境正常
7. 输出可用的测试命令清单

$ARGUMENTS
