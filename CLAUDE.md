# MCP Sentinel 项目宪章

## 🎯 项目目标
构建一个像"Postman for MCP"一样的测试工具，能够自动发现、连接并测试 MCP 服务器的可用性、响应速度以及工具调用的正确性。

## 🏗️ 技术栈与架构
- **语言**: TypeScript (严格模式)
- **运行时**: Node.js (v20+)
- **测试框架**: Vitest 或 Jest
- **包管理器**: pnpm
- **核心依赖**: `@modelcontextprotocol/sdk` (官方 SDK)
- **架构原则**:
  - 模块化设计：解析器、探针、报告器三大核心模块解耦。
  - 配置驱动：支持从 `mcp.json` 或环境变量读取目标服务器配置。
  - 并发控制：默认限制同时测试的服务器数量（如5个），避免资源耗尽。

## 📝 代码规范
- **格式化**: 使用 Prettier 统一代码风格。
- **Lint**: 使用 ESLint (遵循 Airbnb 或 Standard 规范)。
- **命名约定**:
  - 文件名：`kebab-case` (如 `mcp-probe.ts`)。
  - 类名/接口：`PascalCase` (如 `MCPServerProbe`)。
  - 变量/函数：`camelCase` (如 `listTools`)。
  - 常量/枚举：`UPPER_SNAKE_CASE` (如 `DEFAULT_TIMEOUT`)。

## ✅ 核心质量标准（优先级递减）
1. **连通性**：能否成功建立连接并完成初始化握手？
2. **协议合规性**：是否严格遵循 MCP 协议规范？
3. **工具可用性**：能否成功 tools/list 并正确执行 tools/call？
4. **性能与稳定性**：平均响应延迟是否在可接受范围内（<3s）？

## 🚫 明确禁止
- 禁止修改 `claude_desktop_config.json`
- 测试调用必须设置超时（默认10秒）
- 代码保持可读性，关键逻辑需注释
- 不确定时要求用户提供文档，不可自行猜测

## 🔒 安全与隐私
- 所有测试在本地沙盒环境中进行
- 敏感信息通过环境变量注入，严禁硬编码
