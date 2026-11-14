# Preview-Video-Image

面向 NAS 的本地图片、视频媒体库，基于 [telegram-media-downloader](https://github.com/botnick/telegram-media-downloader) 修改。当前版本：`3.4.19+zhcn21.library10`。

## 已包含的功能

- 只读挂载媒体大目录，在网页中手动添加子目录、分类、改名和移除。
- 定时同步已添加的目录，默认每 5 分钟扫描，文件稳定等待 60 秒；支持修改间隔和关闭。
- 跳过常见下载临时文件，扫描不重叠，未变化的文件保留索引、收藏和识别结果。
- 设置页面独立展示媒体库维护、安全与 AI、备份与同步、系统，并提供对应快捷导航。
- NSFW 分类、人脸识别通过独立容器提供。
- 控制面板密码修改：验证当前密码、确认新密码，新密码至少 8 位。
- 本地定制界面隐藏上游更新入口和自动更新检查。

## 仓库范围

保存源码、Dockerfile、配置模板和部署说明。真实 `.env`、密码、API 密钥、数据库、收藏、模型缓存及媒体文件保存在部署机器，不提交到 Git。

源码同步不能替代运行数据备份。原项目说明和许可证分别见 [README.upstream.md](README.upstream.md) 与 [LICENSE](LICENSE)。模型权重遵循各自发布方的许可。

## 部署

需要 Linux amd64、Docker Compose v2。为三个服务预留足够内存，建议至少 8 GB。

```bash
git clone https://github.com/mykunas/Preview-Video-Image.git
cd Preview-Video-Image
cp .env.example .env
```

编辑 `.env`：设置实际媒体路径、端口，以及两个独立的 sidecar API token。可用 `python3 -c 'import secrets; print(secrets.token_urlsafe(32))'` 生成随机 token。

主程序需要先准备镜像：已有 NAS 离线镜像可用 `docker load -i 镜像文件.tar` 导入；否则在有足够资源的构建机器执行：

```bash
docker build -t preview-video-image:3.4.19-library10 .
```

此命令会编译 Go 源码；内存较少的 NAS 建议在其他机器构建，再导入镜像。

```bash
mkdir -p data nsfw-models
docker compose -f compose.yml up -d
```

首次启动 NSFW 服务会下载模型。人脸服务使用镜像附带的模型。随后初始化控制面板密码：

```bash
read -rs -p '输入控制面板密码（至少8位）: ' dashboard_password; echo
printf '%s\n' "$dashboard_password" | docker compose exec -T -u node preview-video-image tgdl-server setup --password-stdin
unset dashboard_password
```

访问 `http://服务器IP:39100`，进入“设置 → 本地文件夹”选择媒体子目录，并调整自动同步设置。

## 日常管理

```bash
docker compose ps
docker compose logs --tail 100
```

后续拉取源码使用 `git pull`。应用代码嵌入程序中，源码更新后需要重新构建/导入镜像并重建容器，网页才会使用新版本。

## 验证

相关功能测试位于 `core-service/internal/app/local_folders_test.go` 和 `local_folder_schedule_test.go`。目录扫描、设置持久化、权限检查、下载临时文件跳过和增量索引均有测试覆盖。
