@echo off
setlocal

echo ==========================================
echo   WordFlow GitHub Push Setup
echo ==========================================
echo.

REM --- Your GitHub identity ---
git config --global user.name "singhsarabjit007-a11y"
git config --global user.email "singhsarabjit007@gmail.com"

REM --- Initialize repo if needed ---
if not exist ".git" (
    echo Initializing Git repository...
    git init
)

REM --- Add all files ---
echo Adding files...
git add .

REM --- Commit if there are staged changes ---
git diff --cached --quiet
if errorlevel 1 (
    echo Creating commit...
    git commit -m "Initial WordFlow V1"
) else (
    echo No new changes to commit.
)

REM --- Ensure main branch ---
git branch -M main

REM --- Set correct GitHub remote ---
git remote get-url origin >nul 2>&1
if errorlevel 1 (
    echo Adding GitHub remote...
    git remote add origin https://github.com/singhsarabjit007-a11y/wordflow.git
) else (
    echo Fixing GitHub remote...
    git remote set-url origin https://github.com/singhsarabjit007-a11y/wordflow.git
)

echo.
echo Remote is now:
git remote -v
echo.

REM --- Push ---
echo Pushing WordFlow to GitHub...
echo A browser may open for GitHub authentication.
git push -u origin main

if errorlevel 1 (
    echo.
    echo ==========================================
    echo PUSH FAILED
    echo ==========================================
    echo.
    echo Make sure this GitHub repository exists:
    echo https://github.com/singhsarabjit007-a11y/wordflow
    echo.
    echo If it does not exist, create an EMPTY repository named:
    echo wordflow
    echo.
    pause
    exit /b 1
)

echo.
echo ==========================================
echo SUCCESS
echo WordFlow has been pushed to GitHub.
echo ==========================================
echo.
pause
