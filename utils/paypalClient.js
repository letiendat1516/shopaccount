const paypal = require('@paypal/checkout-server-sdk');
const mongoose = require('mongoose');
const { decrypt } = require('./encryption');

let paypalClientInstance = null;
let lastConfigHash = null;

async function getPayPalClient() {
  try {
    const settingsModel = mongoose.model('Settings');
    const settings = await settingsModel.findOne();
    
    if (!settings || !settings.paymentMethods?.paypal?.enabled) {
      throw new Error('PayPal is not enabled in settings');
    }

    const paypalConfig = settings.paymentMethods.paypal;
    
    if (paypalConfig.accountType === 'personal') {
      if (!paypalConfig.personalEmail) {
        throw new Error('PayPal personal email not configured');
      }
      return null;
    }
    
    const configHash = JSON.stringify({
      mode: paypalConfig.mode,
      clientId: paypalConfig.clientId,
      clientSecret: paypalConfig.clientSecret
    });
    
    if (paypalClientInstance && configHash === lastConfigHash) {
      return paypalClientInstance;
    }

    const clientId = decrypt(paypalConfig.clientId);
    const clientSecret = decrypt(paypalConfig.clientSecret);

    if (!clientId || !clientSecret) {
      throw new Error('PayPal credentials not configured');
    }

    const environment = paypalConfig.mode === 'sandbox'
      ? new paypal.core.SandboxEnvironment(clientId, clientSecret)
      : new paypal.core.LiveEnvironment(clientId, clientSecret);

    paypalClientInstance = new paypal.core.PayPalHttpClient(environment);
    lastConfigHash = configHash;
    
    return paypalClientInstance;
  } catch (error) {
    console.error('Error initializing PayPal client:', error);
    throw error;
  }
}

module.exports = getPayPalClient;