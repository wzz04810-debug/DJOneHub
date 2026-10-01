# 内置首次部署包

发布 Windows 测试版前，将经人工验证的 `module-update-0.3.15-first-use.djupdate` 放入本目录。文件受仓库根目录 `.gitignore` 保护，不能提交。

打包程序会读取 `baseline.json`，并同时校验文件名、大小与 SHA-256。任何一项不匹配时，工具不会在界面中列出刷机包。
