@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 启动画布后端 http://127.0.0.1:8770
echo 关掉这个窗口 = 停止服务
echo.
python server\app.py --port 8770
if errorlevel 1 (
  echo.
  echo 启动失败，检查 Python 是否在 PATH 里。
  pause
)
