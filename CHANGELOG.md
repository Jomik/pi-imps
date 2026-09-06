# Changelog

## [0.7.0](https://github.com/Jomik/pi-imps/compare/v0.6.0...v0.7.0) (2026-09-06)


### Features

* add project imp tool grants UI ([#18](https://github.com/Jomik/pi-imps/issues/18)) ([54e3d6c](https://github.com/Jomik/pi-imps/commit/54e3d6c40f0e56daab316666bafecbce81e4c54b))
* **thinking:** inherit parent thinking level for imps ([ffe61ef](https://github.com/Jomik/pi-imps/commit/ffe61ef89359ff15c9ce423f21e3eb61f33dc153))
* **tui:** show summon task previews ([2eda0d2](https://github.com/Jomik/pi-imps/commit/2eda0d24a51227df330097550afdbbf810c3f5c0))


### Bug Fixes

* cache available agents block per session ([#17](https://github.com/Jomik/pi-imps/issues/17)) ([a9e76b4](https://github.com/Jomik/pi-imps/commit/a9e76b41d9f15893a17150668330993bcbe8cc88))
* resolve imp extension package name independent of sourceInfo timing ([178e912](https://github.com/Jomik/pi-imps/commit/178e91246f23bf4cc09c52a4c9a11ecd8ea88dc7))
* **session:** surface provider failures from imp runs ([7e02c3d](https://github.com/Jomik/pi-imps/commit/7e02c3d06e3229fb5e72817b68261f8cbcbc7e6e))
* surface and normalize imp failures ([#21](https://github.com/Jomik/pi-imps/issues/21)) ([4e253e4](https://github.com/Jomik/pi-imps/commit/4e253e44b60f1b8aa4dad85b3e950484ff0b960e))
* surface imp runtime and configuration errors ([#20](https://github.com/Jomik/pi-imps/issues/20)) ([5cd841c](https://github.com/Jomik/pi-imps/commit/5cd841cc7459a1c1ebdc4cd8c588e986e06cd640))
* **thinking:** honor agent thinking level ([#19](https://github.com/Jomik/pi-imps/issues/19)) ([0026f43](https://github.com/Jomik/pi-imps/commit/0026f436e7f4e364467e44bc2b7c7aaa4e3b0818))

## [0.6.0](https://github.com/Jomik/pi-imps/compare/v0.5.0...v0.6.0) (2026-05-24)


### Features

* project-level imps.json for per-agent additive tools ([#14](https://github.com/Jomik/pi-imps/issues/14)) ([1928398](https://github.com/Jomik/pi-imps/commit/192839883ccb8d64e91ca41935c8977dc40b38b8))

## [0.5.0](https://github.com/Jomik/pi-imps/compare/v0.4.0...v0.5.0) (2026-05-11)


### Features

* move global config to dedicated ~/.pi/agent/imps.json with JSON Schema ([#12](https://github.com/Jomik/pi-imps/issues/12)) ([59e8615](https://github.com/Jomik/pi-imps/commit/59e8615d0cf4bd4c7eb7d53fb320f5feb5f53952))

## [0.4.0](https://github.com/Jomik/pi-imps/compare/v0.3.0...v0.4.0) (2026-05-07)


### ⚠ BREAKING CHANGES

* migrate npm scope from @mariozechner to @earendil-works ([#10](https://github.com/Jomik/pi-imps/issues/10))

### Features

* migrate npm scope from [@mariozechner](https://github.com/mariozechner) to [@earendil-works](https://github.com/earendil-works) ([#10](https://github.com/Jomik/pi-imps/issues/10)) ([4113b40](https://github.com/Jomik/pi-imps/commit/4113b40d8d176ea3cf547466ba3710488f6fd1ab))

## [0.3.0](https://github.com/Jomik/pi-imps/compare/v0.2.0...v0.3.0) (2026-04-30)


### Features

* clarify imp tool descriptions for delegators ([#5](https://github.com/Jomik/pi-imps/issues/5)) ([095a669](https://github.com/Jomik/pi-imps/commit/095a6696ec316b56c75b21a3279994653ad7b9ca))
* per-agent turn limit via 'turns' frontmatter ([#4](https://github.com/Jomik/pi-imps/issues/4)) ([6303a93](https://github.com/Jomik/pi-imps/commit/6303a93aa1aa812faa246dd362762329b8a15e0e))


### Bug Fixes

* **ci:** add .node-version and configure setup-node for OIDC publishing ([59bc0bb](https://github.com/Jomik/pi-imps/commit/59bc0bba4e99b8173508b8ef572db09fbc8d7609))
* replace non-null assertions with optional chaining in tools.ts ([#9](https://github.com/Jomik/pi-imps/issues/9)) ([aebf49f](https://github.com/Jomik/pi-imps/commit/aebf49f848fc2dbf4339721347077f7fc1efd32d))
* **session:** inherit filtered runtime settings for imps ([#8](https://github.com/Jomik/pi-imps/issues/8)) ([3d64f93](https://github.com/Jomik/pi-imps/commit/3d64f93c31e3c290af2177884faf4e28196fb84f))
* validate summon parameters and agent model availability ([#2](https://github.com/Jomik/pi-imps/issues/2)) ([9ce14af](https://github.com/Jomik/pi-imps/commit/9ce14af00c27595d5b5d9ade56cbde55f84ce748))

## [0.2.0](https://github.com/Jomik/pi-imps/compare/v0.1.1...v0.2.0) (2026-04-23)


### ⚠ BREAKING CHANGES

* requires typebox >=1.0.0 and pi-coding-agent >=0.69.0

### Bug Fixes

* migrate from @sinclair/typebox 0.34 to typebox 1.x for pi 0.69.0 ([fadb978](https://github.com/Jomik/pi-imps/commit/fadb97826fddc30f31f10491c81f3b7f671fea3d))
