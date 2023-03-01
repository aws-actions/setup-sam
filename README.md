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
      - uses: aws-actions/configure-aws-credentials@v1
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
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
> Only supported on Linux x86-64 runners currently.

Set to `true` to install using native installers instead of `pip`. Defaults to `false`.

### `python`

The Python interpreter to use for AWS SAM CLI when `use-installer` is set to `false`. Defaults to `python` on Windows, and `python3` otherwise.

You can use [`actions/setup-python`](https://github.com/actions/setup-python) to automatically set up Python.

## Security

See [CONTRIBUTING.md](CONTRIBUTING.md#security-disclosures) for more information.

## License

This project is licensed under the [Apache-2.0 License](LICENSE).
