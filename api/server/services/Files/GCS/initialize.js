const { Storage } = require('@google-cloud/storage');
const { getOAuthClient } = require('~/server/services/OAuthService');


const STORAGE_BASE_URL = 'https://storage.cloud.google.com/'

const initializeGCS = async (userId) => {

    const oauth2Client = await getOAuthClient(userId);

    const gcs = new Storage({
        projectId: process.env.GCS_PROJECT_ID,
        authClient: oauth2Client
    });
    return gcs.bucket(process.env.GCS_BUCKET_NAME);
}

module.exports = {
    STORAGE_BASE_URL,
    initializeGCS
}
