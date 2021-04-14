# setup-sam

[![Tests](https://github.com/aws-actions/setup-sam/actions/workflows/test.yml/badge.svg)](https://github.com/aws-actions/setup-sam/actions/workflows/test.yml)
[![CodeQL](https://github.com/aws-actions/setup-sam/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/aws-actions/setup-sam/actions/workflows/codeql-analysis.yml)

Action to setup [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-reference.html#serverless-sam-cli) and add it to the `PATH`.

Requires Python 3.6+.

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
      - uses: actions/checkout@v2
      - uses: actions/setup-python@v2
      - uses: aws-actions/setup-sam@v1
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

## Inputs

### `version`

The AWS SAM CLI version to install. Installs the latest version by default.

### `python`

The Python interpreter to use for AWS SAM CLI. Defaults to `python` on Windows, and `python3` otherwise.

## Security

See [CONTRIBUTING.md](CONTRIBUTING.md#security-disclosures) for more information.

## License

This project is licensed under the [Apache-2.0 License](LICENSE).
