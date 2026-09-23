@echo off
rem Rebuilds everything: Rust engine (native + wasm), server deps, web app.
setlocal
cd /d "%~dp0"
set CARGO=cargo
where cargo >nul 2>nul || set CARGO=%USERPROFILE%\.cargo\bin\cargo.exe
set RUSTUP=rustup
where rustup >nul 2>nul || set RUSTUP=%USERPROFILE%\.cargo\bin\rustup.exe

echo == engine: cargo build --release
pushd engine
"%CARGO%" build --release || goto :fail
echo == engine for the browser: wasm
"%RUSTUP%" target add wasm32-unknown-unknown >nul || goto :fail
"%CARGO%" build --profile wasm --target wasm32-unknown-unknown --lib || goto :fail
popd
echo == server deps: npm install
pushd node
call npm install --no-audit --no-fund || goto :fail
popd
echo == web: npm install + build
pushd web
call npm install --no-audit --no-fund || goto :fail
call npm run build || goto :fail
popd
echo == done. local: node\start-server.cmd - static hosting: upload web\dist
pause
exit /b 0

:fail
echo == build failed
pause
exit /b 1
