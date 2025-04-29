const { OAuth2Client } = require('google-auth-library');
const { getUserById, updateUser } = require('~/models/userMethods');
const { logger } = require('~/config');

/**
 * Retrieves a new access token using the given refresh token.
 * @param {String} refreshToken - The users refresh_token (code 1/...) object.
 * @returns {Promise<GetAccessTokenResponse>} - A new access token.
 */
async function getNewAccessToken(refreshToken) {
  try {
    const oAuth2Client = createNewOAuthClient();
    oAuth2Client.setCredentials({
      refresh_token: refreshToken,
    });
    const { token } = await oAuth2Client.getAccessToken();
    return token;
  } catch (error) {
    logger.error('Error obtain access token:', error);
    throw error;
  }
}

/**
 * The OAuth2 client.
 * @returns {OAuth2Client} - The OAuth2 client.
 */
function createNewOAuthClient() {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.DOMAIN_CLIENT}/login`,
  );
}

/**
 * check if refresh token is valid
 * @param {UserObject} - The users object.
 * @returns {Promise<GetAccessTokenResponse>} - access_token if valid, null if not valid.
 */
async function createAccessTokenForValidRefreshToken(user) {
  try {
    const refreshToken =
      user.refreshToken && user.refreshToken[0] && user.refreshToken[0].refreshToken;
    if (!refreshToken) {
      throw new Error('Function createAccessTokenForValidRefreshToken: Refresh token not found');
    }
    const accessToken = await getNewAccessToken(refreshToken);
    return accessToken;
  } catch (refreshError) {
    return null;
  }
}

/**
 *  Retrieves an OAuth2 client for the user with the given ID.
 *
 * @param {string} userId - The user ID.
 * @returns {Promise<OAuth2Client>} - A promise that resolves to the OAuth2 client.
 */
async function getOAuthClient(userId) {
  const user = await getUserById(userId);
  if (!user) {
    throw new Error('Function getOAuthClient: User not found');
  }
  // Check if credential are expired
  if (
    !user.credentials ||
    !user.credentials.expiry_date ||
    user.credentials.expiry_date <= Date.now()
  ) {
    try {
      const accessToken = await createAccessTokenForValidRefreshToken(user);
      if (!accessToken) {
        throw new Error('Function getOAuthClient: Refresh token not valid');
      }
      // update credentials
      user.credentials.access_token = accessToken;
      user.credentials.expiry_date = Date.now() + 3600 * 1000; // 1 hour
      await updateUser(userId, { credentials: user.credentials }); // Update entire credentials object
    } catch (refreshError) {
      const errorMsg = `Function getOAuthClient: refreshing credentials for user ${userId}:`;
      logger.error(errorMsg, refreshError);
      throw new Error(errorMsg, refreshError);
    }
  }
  const oAuth2Client = await createNewOAuthClient();
  oAuth2Client.setCredentials(user.credentials);
  return oAuth2Client;
}

module.exports = {
  getOAuthClient,
  createAccessTokenForValidRefreshToken,
};
