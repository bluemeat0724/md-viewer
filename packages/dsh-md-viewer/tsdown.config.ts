/**
 * 独立 tsdown 配置：自包含构建（不依赖任何 dsh-web-ui 仓库）。
 * host 半区 → lib/index.js（ESM）；client 半区 → lib/client.js
 * （closure-factory 产物，供 GUI 的 __ModuleLoader__ 加载；CSS Modules
 * 内联，externals 经 loader 模块表解析）。构建预设为本包 build/ 内 vendored
 * 副本（源自 dsh-web-ui shared/tsdown.client.ts，升级 SDK 时同步）。
 */
import { clientBundle } from './build/tsdown.client.ts'

export default clientBundle('@bluemeat0724/dsh-md-viewer', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-workspace',
  ],
})
