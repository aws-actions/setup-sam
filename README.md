# setup-sam

[![Tests](https://github.com/aws-actions/setup-sam/actions/workflows/test.yml/badge.svg)](https://github.com/aws-actions/setup-sam/actions/workflows/test.yml)
[![Release](https://github.com/aws-actions/setup-sam/actions/workflows/release.yml/badge.svg)](https://github.com/aws-actions/setup-sam/actions/workflows/release.yml)

Action to set up [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-reference.html#serverless-sam-cli) and add it to the `PATH`.

This action enables you to run AWS SAM CLI commands in order to build, package, and deploy [serverless applications](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html) as part of your workflow.

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
      - uses: actions/checkout@v3
      - uses: aws-actions/setup-sam@v2
        with:
          use-installer: true
          token: ${{ secrets.GITHUB_TOKEN }}
      - uses: aws-actions/configure-aws-credentials@v2
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

## Inputs

### `version`

The AWS SAM CLI version to install. Installs the latest version by default.

### `use-installer`

> **Note**
>
> This is the recommended approach on supported platforms. It does not require Python to be installed, and is faster than the default installation method.
>
> Currently supports Linux x86-64 and aarch64 (ARM) runners. For ARM architecture, only versions 1.104.0 and above are supported.
> Set to `true` to set up AWS SAM CLI using a native installer. Defaults to `false`.

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
