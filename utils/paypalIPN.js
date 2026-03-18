const axios = require('axios');
const fs = require('fs');
const yaml = require("js-yaml")
const config = yaml.load(fs.readFileSync('./config.yml', 'utf8'));

async function verifyIPN(ipnData) {
  const verifyData = 'cmd=_notify-validate&' + new URLSearchParams(ipnData).toString();
  
  const paypalUrl = 'https://ipnpb.paypal.com/cgi-bin/webscr';

  try {
    const response = await axios.post(paypalUrl, verifyData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Node-IPN-VerificationScript'
      }
    });

    return response.data === 'VERIFIED';
  } catch (error) {
    console.error('[IPN] Verification request failed:', error.message);
    return false;
  }
}

module.exports = { verifyIPN };