// Check if the user has a valid refesh token to access GCS
const { createAccessTokenForValidRefreshToken } = require('~/server/services/OAuthService');
const { logger } = require('~/config');

/**
 * Check if refresh token is valid, otherwise redirect to login
 */
const checkOAuthValid = async (req, res, next) => {
  try {
    const user = req?.user;
    if (!user) {
      return res.status(401).send({ message: 'User not found' });
    }
    const accessToken = await createAccessTokenForValidRefreshToken(user);
    if (!accessToken) {
      return res.status(403).send({ message: 'Refresh token is invalid' });
    }
    next();
  } catch (error) {
    logger.error('Error in checking oAuth validity:', error);
  }
};

module.exports = checkOAuthValid;
