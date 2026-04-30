# Changelog

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
