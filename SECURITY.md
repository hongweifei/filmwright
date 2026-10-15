# 安全政策

## 支持的版本

| 版本 | 是否接收安全报告 |
|---|---|
| 0.1.x | 是（只修最新版） |

## 如何报告

**优先使用 GitHub 的私密漏洞报告**（仓库页 Security → Report a vulnerability），不要公开 issue 描述漏洞。

报告时附：影响范围、复现步骤或 PoC、你的评估（严重程度 / 利用条件）。我们会在收到后先确认收到，再评估、修复、发布，修复时在 CHANGELOG 里注明。

## 范围与边界

filmwright 是**本地开发工具**：它起本地 HTTP 服务、驱动本地浏览器、调用 ffmpeg 与 Python。设计上假定使用者在本机运行自己的项目。

- 属于攻击面的：`preview` / 渲染用的本地服务（路径穿越防护在 `src/host/project/server.mjs`）、CDP 会话、外部命令调用（ffmpeg / python）；
- 不属于攻击面的：渲染出来的 mp4 本身、示例素材与库自带的字体（各自许可见 [`fonts/LICENSE.md`](fonts/LICENSE.md)）。
