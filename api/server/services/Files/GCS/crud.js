const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { getBufferMetadata } = require('~/server/utils');
const { initializeGCS, STORAGE_BASE_URL } = require('./initialize');
const { logger } = require('~/config');

/**
 * Deletes a file from GCS Storage.
 * @param {string} directory - The directory name
 * @param {string} fileName - The name of the file to delete.
 * @returns {Promise<void>} A promise that resolves when the file is deleted.
 */
const deleteGCSFile = async (req, mongoFile) => {
  const filePath = mongoFile.filepath;
  const userId = req.user.id;
  const bucket = await initializeGCS(userId);
  if (!bucket) {
    logger.error('GCS bucket seems not initialized. Cannot save file to GCS Storage.');
    return null;
  }
  // Remove the base URL from the file path to get the path relative to the bucket
  const gsFilePath = filePath.replace(STORAGE_BASE_URL+bucket.name+'/', '');
  const file = bucket.file(gsFilePath);

  try {
    await file.delete();
    logger.debug('File deleted successfully from Google Cloud Storage');
  } catch (error) {
    logger.error('Error deleting file from Google Cloud Storage:', error.message);
    throw error;
  }
}

/**
 * Saves an file from a given URL to GCS Storage. The function first initializes the GCS Storage
 * reference, then uploads the file to a specified basePath in the GCS Storage. It handles initialization
 * errors and upload errors, logging them to the console. If the upload is successful, the file name is returned.
 *
 * @param {Object} params - The parameters object.
 * @param {string} params.userId - The user's unique identifier. This is used to create a user-specific basePath
 *                                 in GCS Storage.
 * @param {string} params.URL - The URL of the file to be uploaded. The file at this URL will be fetched
 *                              and uploaded to GCS Storage.
 * @param {string} params.fileName - The name that will be used to save the file in GCS Storage. This
 *                                   should include the file extension.
 * @param {string} [params.basePath='images'] - Optional. The base basePath in GCS Storage where the file will
 *                                          be stored. Defaults to 'images' if not specified.
 *
 * @returns {Promise<{ bytes: number, type: string, dimensions: Record<string, number>} | null>}
 *          A promise that resolves to the file metadata if the file is successfully saved, or null if there is an error.
 */
async function saveURLToGCS({ userId, URL, fileName, basePath = 'images' }) {
  const bucket = await initializeGCS(userId);
  if (!bucket) {
    logger.error('GCS bucket seems not initialized. Cannot save file to GCS Storage.');
    return null;
  }

  const filePath = `${basePath}/${userId.toString()}/${fileName}`;
  const file = bucket.file(filePath);

  const response = await fetch(URL);
  const buffer = await response.buffer();

  try {
    await file.save(buffer);
    return await getBufferMetadata(buffer);
  } catch (error) {
    logger.error('Error uploading file to Google Cloud Storage:', error.message);
    return null;
  }
}

/**
 * Retrieves the download URL for a specified file from GCS Storage. This function initializes the
 * GCS Storage and generates a reference to the file based on the provided basePath and file name. If
 * GCS Storage is not initialized or if there is an error in fetching the URL, the error is logged
 * to the console.
 *
 * @param {Object} params - The parameters object.
 * @param {string} params.fileName - The name of the file for which the URL is to be retrieved. This should
 *                                   include the file extension.
 * @param {string} [params.basePath='images'] - Optional. The base basePath in GCS Storage where the file is
 *                                          stored. Defaults to 'images' if not specified.
 *
 * @returns {Promise<string|null>}
 *          A promise that resolves to the download URL of the file if successful, or null if there is an
 *          error in initialization or fetching the URL.
 */
async function getHTTPUrl({ userId, fileName, basePath = 'images' }) {
  const bucket = await initializeGCS(userId);
  if (!bucket) {
    logger.error('GCS bucket seems not initialized. Cannot save file to GCS Storage.');
    return null;
  }
  try {
    const filePath = `${basePath}/${userId.toString()}/${fileName}`;
    return STORAGE_BASE_URL + bucket.name + '/' + filePath;
  } catch (error) {
    logger.error('Error fetching file URL from GCS Storage:', error.message);
    return null;
  }
}

/**
 * Retrieves the download URL for a specified file from GCS Storage. This function initializes the
 * GCS Storage and generates a reference to the file based on the provided basePath and file name. If
 * GCS Storage is not initialized or if there is an error in fetching the URL, the error is logged
 * to the console.
 *
 * @param {Object} params - The parameters object.
 * @param {string} params.fileName - The name of the file for which the URL is to be retrieved. This should
 *                                   include the file extension.
 * @param {string} [params.basePath='images'] - Optional. The base basePath in GCS Storage where the file is
 *                                          stored. Defaults to 'images' if not specified.
 *
 * @returns {Promise<string|null>}
 *          A promise that resolves to the download URL of the file if successful, or null if there is an
 *          error in initialization or fetching the URL.
 */
function getGSUrl({userId, fileName, basePath = 'images' }) {
  try {
    bucketName = process.env.GCS_BUCKET_NAME
    const filePath = `${basePath}/${userId.toString()}/${fileName}`;
    return 'gs://' + bucketName + '/' + filePath;
  } catch (error) {
    logger.error('Error fetching file URL from GCS Storage:', error.message);
    return null;
  }
}


/**
 * Uploads a buffer to GCS Storage.
 *
 * @param {Object} params - The parameters object.
 * @param {string} params.userId - The user's unique identifier. This is used to create a user-specific basePath
 *                                 in GCS Storage.
 * @param {string} params.fileName - The name of the file to be saved in GCS Storage.
 * @param {string} params.buffer - The buffer to be uploaded.
 * @param {string} [params.basePath='images'] - Optional. The base basePath in GCS Storage where the file will
 *                                          be stored. Defaults to 'images' if not specified.
 *
 * @returns {Promise<string>} - A promise that resolves to the download URL of the uploaded file.
 */
async function saveBufferToGCS({ userId, buffer, fileName, basePath = 'images' }) {
  const bucket = await initializeGCS(userId);
  if (!bucket) {
    logger.error('GCS bucket seems not initialized. Cannot save file to GCS Storage.');
    return null;
  }

  const filePath = `${basePath}/${userId.toString()}/${fileName}`;
  const file = bucket.file(filePath);

  try {
    await file.save(buffer);
    // Assuming you have a function to get the download URL
    return await getHTTPUrl({ userId, fileName, basePath });
  } catch (error) {
    logger.error('Error uploading file to Google Cloud Storage:', error.message);
    throw new Error('Failed to upload file to Google Cloud Storage');
  }
}


/**
 * Uploads a file to GCS Storage.
 *
 * @param {Object} params - The params object.
 * @param {Express.Request} params.req - The request object from Express. It should have a `user` property with an `id`
 *                       representing the user.
 * @param {Express.Multer.File} params.file - The file object, which is part of the request. The file object should
 *                                     have a `path` property that points to the location of the uploaded file.
 * @param {string} params.file_id - The file ID.
 *
 * @returns {Promise<{ filepath: string, bytes: number }>}
 *          A promise that resolves to an object containing:
 *            - filepath: The download URL of the uploaded file.
 *            - bytes: The size of the uploaded file in bytes.
 */
async function uploadFileToGCS({ req, file, file_id }) {
  const inputFilePath = file.path;
  const inputBuffer = await fs.promises.readFile(inputFilePath);
  const bytes = Buffer.byteLength(inputBuffer);
  const userId = req.user.id;

  const fileName = `${file_id}__${path.basename(inputFilePath)}`;
  try {
    const downloadURL = await saveBufferToGCS({ userId, buffer: inputBuffer, fileName });
    await fs.promises.unlink(inputFilePath);
    return { filepath: downloadURL, bytes };
  } catch (error) {
    logger.error('Error uploading file to Google Cloud Storage:', error.message);
    throw error;
  }
}


module.exports = {
  deleteGCSFile,
  getHTTPUrl,
  getGSUrl,
  saveURLToGCS,
  uploadFileToGCS,
  saveBufferToGCS,
};
