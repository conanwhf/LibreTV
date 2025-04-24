# Azure 部署指南

本文档提供了如何将 LibreTV 部署到 Azure 静态 Web 应用的详细步骤。

## 前提条件

1. 一个 Azure 账户
2. 一个包含 LibreTV 代码的 GitHub 仓库

## 部署步骤

### 1. 创建 Azure 静态 Web 应用

1. 登录 [Azure 门户](https://portal.azure.com/)
2. 点击"创建资源"，搜索并选择"静态 Web 应用"
3. 点击"创建"
4. 填写以下信息：
   - 订阅：选择您的 Azure 订阅
   - 资源组：创建新的或选择现有的
   - 名称：为您的应用程序输入一个名称（例如 "libretv"）
   - 托管计划：选择"免费"
   - 区域：选择最靠近您用户的区域
   - GitHub 账户：连接您的 GitHub 账户
   - 组织：选择您的 GitHub 组织
   - 存储库：选择包含 LibreTV 代码的仓库
   - 分支：选择 "main" 或您的主分支
   - 构建预设：选择"自定义"
   - 应用位置：输入 "/"
   - API 位置：输入 "api"
   - 输出位置：留空

5. 点击"查看 + 创建"，然后点击"创建"

### 2. 配置环境变量

部署完成后，您可以配置环境变量：

1. 在 Azure 门户中，导航到您刚创建的静态 Web 应用
2. 点击"配置" > "应用程序设置"
3. 添加以下环境变量：
   - `PASSWORD`：设置访问密码（可选）
   - `DEBUG`：设置为 "true" 或 "false"
   - `CACHE_TTL`：缓存时间（秒），例如 "86400"
   - `MAX_RECURSION`：最大递归深度，例如 "5"
   - `USER_AGENTS_JSON`：自定义 User Agent 列表（JSON 格式的数组）

4. 点击"保存"

### 3. 设置 GitHub Actions 密钥

为了使 GitHub Actions 工作流能够部署到 Azure，您需要设置一个密钥：

1. 在 Azure 门户中，导航到您的静态 Web 应用
2. 点击"概述"，然后点击"管理部署令牌"
3. 复制部署令牌
4. 在 GitHub 仓库中，导航到"设置" > "密钥和变量" > "操作"
5. 点击"新建仓库密钥"
6. 名称：输入 "AZURE_STATIC_WEB_APPS_API_TOKEN"
7. 值：粘贴您复制的部署令牌
8. 点击"添加密钥"

如果您想设置密码保护，还需要添加：
1. 名称：输入 "SITE_PASSWORD"
2. 值：输入您想要的密码
3. 点击"添加密钥"

### 4. 触发部署

推送更改到您的 GitHub 仓库的主分支，将自动触发部署：

```bash
git add .
git commit -m "准备 Azure 部署"
git push origin main