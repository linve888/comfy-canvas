@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 画布启动中...
echo   画布  http://127.0.0.1:8770
echo   ComfyUI 需要已经在跑（默认 127.0.0.1:8188）
start "" http://127.0.0.1:8770
python "%~dp0server\app.py" --port 8770
pause
