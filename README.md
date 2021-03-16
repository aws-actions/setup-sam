# setup-sam

Action to setup [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-reference.html#serverless-sam-cli) and add it to the `PATH`.

Requires Python 3.6+.

## Inputs

### `version`

The AWS SAM CLI version to install. Installs the latest version by default.

### `python`

The Python interpreter to use for AWS SAM CLI. Defaults to `python` on Windows, and `python3` otherwise.

## Testing and Building

Install dependencies:

```shell
npm install
```

Then run tests and build:

```shell
npm run all
```

## Security

See [CONTRIBUTING.md](CONTRIBUTING.md#security-disclosures) for more information.

## License

This project is licensed under the Apache-2.0 License.
