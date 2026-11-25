xcopy /E /I /Y src ..\snapshots\v1.x-%date%\src\
copy package.json ..\snapshots\v1.x-%date%\
copy package-lock.json ..\snapshots\v1.x-%date%\
copy index.html ..\snapshots\v1.x-%date%\
copy vite.config.js ..\snapshots\v1.x-%date%\
xcopy /I /Y db ..\snapshots\v1.x-%date%\db\
pause