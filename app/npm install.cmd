"C:\Program Files\nodejs\npm.cmd" config set strict-ssl false
"C:\Program Files\nodejs\npm.cmd" install

Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
npm audit fix --force
open
pause