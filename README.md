# setup-sam

[![Tests](https://github.com/aws-actions/setup-sam/actions/workflows/test.yml/badge.svg)](https://github.com/aws-actions/setup-sam/actions/workflows/test.yml)
[![Release](https://github.com/aws-actions/setup-sam/actions/workflows/release.yml/badge.svg)](https://github.com/aws-actions/setup-sam/actions/workflows/release.yml)

Action to set up [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-reference.html#serverless-sam-cli) and add it to the `PATH`.

This action enables you to run AWS SAM CLI commands in order to build, package, and deploy [serverless applications](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html) as part of your workflow.

## Do you need this action?

The AWS SAM CLI is **preinstalled on every GitHub-hosted runner image** (Ubuntu, Windows, and macOS) — see the [`runner-images`](https://github.com/actions/runner-images) repository (e.g. [Ubuntu 24.04](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md), [Ubuntu 22.04](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2204-Readme.md), [Windows 2025](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md), [macOS 15](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-Readme.md)) for the exact version shipped with each image. If your workflow only needs the version that comes with the runner, you can call `sam` directly without using this action.

Use this action when you need:

- A **specific version** of the SAM CLI (pinned via the `version` input).
- The **`nightly` release** of the SAM CLI to validate upcoming changes before they ship.
- A consistent SAM CLI version across runner image upgrades.
- The native installer on a runner where SAM CLI is not preinstalled (e.g. self-hosted runners).

## Example

Assuming you have a [`samconfig.toml`](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-config.html) at the root of your repository:

```yaml
on:
  push:
    branches:
      - main
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: aws-actions/setup-sam@v3
        with:
          use-installer: true
          token: ${{ secrets.GITHUB_TOKEN }}
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: ${{ secrets.ASSUME_ROLE_ARN }}
          role-session-name: ci
          aws-region: us-east-2
      # Build inside Docker containers
      - run: sam build --use-container
      # Prevent prompts and failure when the stack is unchanged
      - run: sam deploy --no-confirm-changeset --no-fail-on-empty-changeset
```

See [AWS IAM best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html) for handling AWS credentials.

### Installing the nightly release

To validate your project against unreleased changes to the AWS SAM CLI:

```yaml
- uses: aws-actions/setup-sam@v3
  with:
    use-installer: true
    version: nightly
- run: sam --version
```

## Inputs

### `version`

The AWS SAM CLI version to install. Installs the latest stable version by default.

Accepts:

- An exact version (`x.y.z`, e.g. `1.139.0`) — pinned install.
- A version pattern (`1.*`, `1.139.*`) — only when `use-installer` is `false` (resolved by `pip`).
- `nightly` — installs the latest [nightly release](https://github.com/aws/aws-sam-cli/releases/tag/sam-cli-nightly) of the SAM CLI. Requires `use-installer: true`. Nightly releases are not cached because the `sam-cli-nightly` tag is updated in place each day.

### `use-installer`

> **Note**
>
> This is the recommended approach on supported platforms. It does not require Python to be installed, and is faster than the default installation method.
>
> Currently supports:
>
> - Linux x86-64 and aarch64 (ARM) — uses the official archive installer. For ARM, only versions 1.104.0 and above are supported.
> - Windows x86-64 — uses the official MSI installer (`AWS_SAM_CLI_64_PY3.msi`).

Set to `true` to set up AWS SAM CLI using a native installer. Defaults to `false`. Required when `version` is set to `nightly`.

### `python`

> **Note**
>
> Unused if `use-installer` is set to `true`.

The Python interpreter to use for AWS SAM CLI. Defaults to `python` on Windows, and `python3` otherwise.

You can use [`actions/setup-python`](https://github.com/actions/setup-python) to automatically set up Python.

### `token`

> **Note**
>
> It is recommended to use token to have higher rate limit. Default [unauthenticated users](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28#primary-rate-limit-for-unauthenticated-users) without a token will have a lesser rate limit enforced.

The GITHUB Authentication token to use for calling the GITHUB [Get the latest release](https://docs.github.com/en/rest/releases/releases?apiVersion=2022-11-28#get-the-latest-release) API. Defaults to call the API as unauthenticated request if not specified.

The parameter can accept either [`GITHUB_TOKEN`](https://docs.github.com/en/actions/security-guides/automatic-token-authentication) or [`PAT(Personal Access Token)`](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) tokens.

## Security

See [CONTRIBUTING.md](CONTRIBUTING.md#security-disclosures) for more information.

## License

This project is licensed under the [Apache-2.0 License](LICENSE).
