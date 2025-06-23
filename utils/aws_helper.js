const {SecretsManagerClient, GetSecretValueCommand} = require('@aws-sdk/client-secrets-manager');

const aws_secret_name = "prod/hrmos-scraper-creds"; // the name of the secret in AWS Secrets Manager
const aws_region = "ap-northeast-1";

const client = new SecretsManagerClient();

let cachedSecrets = null;

async function getSecrets() {

    console.log("Getting secrets from AWS Secrets Manager: ", aws_secret_name, "")

    if (cachedSecrets) {
        console.log("Using cached secrets")
        return cachedSecrets
    }


    try {
        const command = new GetSecretValueCommand({SecretId: aws_secret_name});
        const data = await client.send(command);

        if (!data.SecretString) throw new Error('SecretString is empty or undefined.');

        cachedSecrets = JSON.parse(data.SecretString);

        console.log("Retrieved secrets from AWS Secrets Manager.")

        return cachedSecrets;
    } catch (error) {
        console.error('Failed to retrieve secrets from AWS Secrets Manager:', error);
        throw error;
    }
}

module.exports = {getSecrets};