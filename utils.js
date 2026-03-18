const fs = require('fs').promises;
const fsSync = require('fs');
const yaml = require("js-yaml")
const config = yaml.load(fsSync.readFileSync('./config.yml', 'utf8'));
const axios = require('axios');
const color = require('ansi-colors');
const settingsModel = require('./models/settingsModel')
const { client } = require("./index.js")
const Discord = require('discord.js');
const path = require('path');
const crypto = require('crypto');
const unzipper = require('unzipper');
const archiver = require('archiver');
const { PassThrough } = require('stream');
const PDFDocument = require('pdfkit');
const moment = require('moment');
const sgMail = require('@sendgrid/mail');
const nodemailer = require('nodemailer');
const stream = require('stream');
const { pipeline } = require('stream/promises');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const placeholderCache = new Map();
const processedFileCache = new Map();

const tempFiles = new Set();

process.on('exit', cleanupTempFiles);
process.on('SIGINT', () => {
  cleanupTempFiles();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupTempFiles();
  process.exit(0);
});

function cleanupTempFiles() {
    for (const tempFile of tempFiles) {
        try {
            if (fsSync.existsSync(tempFile)) {
                fsSync.unlinkSync(tempFile);
            }
        } catch (err) {
            console.error('Error cleaning up temp file:', tempFile, err);
        }
    }
    tempFiles.clear();
}
exports.generateInvoicePdf = async function(payment, config, globalSettings) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: {
          Title: `${globalSettings.storeName} - Invoice #${payment.ID}`,
          Author: globalSettings.storeName,
          Subject: 'Purchase Invoice',
          Keywords: 'invoice, purchase, receipt',
          CreationDate: new Date()
        }
      });

      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });

      const colors = {
        primary: globalSettings.accentColor || '#5e99ff',
        dark: '#0a0a0a',
        darkLighter: '#1a1a1a',
        text: '#ffffff',
        lightText: '#a1a1aa',
        veryLightText: '#71717a',
        background: '#0a0a0a',
        cardBg: '#1a1a1a',
        border: '#2a2a2a',
        success: '#10b981'
      };

      const fonts = {
        regular: 'Helvetica',
        bold: 'Helvetica-Bold',
        oblique: 'Helvetica-Oblique'
      };

      doc.rect(0, 0, 595, 842).fill(colors.background);

      doc.font(fonts.regular);
      
      const headerHeight = 100;
      doc.rect(0, 0, 595, headerHeight)
         .fill(colors.darkLighter);

      const logoPath = path.join(process.cwd(), globalSettings.logoPath?.substring(1));
      if (fsSync.existsSync(logoPath)) {
        try {
          doc.image(logoPath, 50, 30, { width: 50, height: 50 });
        } catch (err) {
          doc.fontSize(18)
             .fillColor(colors.primary)
             .font(fonts.bold)
             .text(globalSettings.storeName, 50, 40);
        }
      } else {
        doc.fontSize(18)
           .fillColor(colors.primary)
           .font(fonts.bold)
           .text(globalSettings.storeName, 50, 40);
      }

      doc.fontSize(8)
         .fillColor(colors.lightText)
         .font(fonts.regular)
         .text(config.StoreAddress?.line1 || '', 110, 38)
         .text(config.StoreAddress?.city ? `${config.StoreAddress.city}, ${config.StoreAddress.state} ${config.StoreAddress.zip}` : '', 110, 50)
         .text(`${config.baseURL}`, 110, 62, { link: config.baseURL });

      doc.fontSize(24)
         .fillColor(colors.text)
         .font(fonts.bold)
         .text('INVOICE', 400, 35, { align: 'right' });

      doc.fontSize(9)
         .fillColor(colors.lightText)
         .font(fonts.regular)
         .text(`#${payment.ID}`, 400, 65, { align: 'right' });

      let currentY = headerHeight + 30;

      doc.roundedRect(50, currentY, 245, 90, 8)
         .fillAndStroke(colors.cardBg, colors.border);

      doc.fontSize(9)
         .fillColor(colors.primary)
         .font(fonts.bold)
         .text('BILL TO', 65, currentY + 15);

      doc.fontSize(10)
         .fillColor(colors.text)
         .font(fonts.bold)
         .text(payment.username, 65, currentY + 32, { width: 215 });

      doc.fontSize(8)
         .fillColor(colors.lightText)
         .font(fonts.regular)
         .text(`User ID: ${payment.userID}`, 65, currentY + 48)
         .text(`Email: ${payment.email}`, 65, currentY + 62, { width: 215 });

      doc.roundedRect(305, currentY, 245, 90, 8)
         .fillAndStroke(colors.cardBg, colors.border);

      doc.fontSize(9)
         .fillColor(colors.primary)
         .font(fonts.bold)
         .text('INVOICE DETAILS', 320, currentY + 15);

      const detailsY = currentY + 35;
      const labelX = 320;
      const valueX = 425;
      const valueWidth = 110;

      doc.fontSize(8)
         .fillColor(colors.lightText)
         .font(fonts.regular)
         .text('Invoice Date:', labelX, detailsY)
         .text('Transaction ID:', labelX, detailsY + 14)
         .text('Payment Method:', labelX, detailsY + 28);

      doc.fillColor(colors.text)
         .font(fonts.regular)
         .text(moment(payment.createdAt).format('MMM D, YYYY'), valueX, detailsY, { align: 'right', width: valueWidth })
         .text(payment.transactionID, valueX, detailsY + 14, { align: 'right', width: valueWidth, ellipsis: true })
         .text(payment.paymentMethod.charAt(0).toUpperCase() + payment.paymentMethod.slice(1), valueX, detailsY + 28, { align: 'right', width: valueWidth });

      const statusBadgeY = currentY + 15;
      const statusBadgeX = 490;
      doc.roundedRect(statusBadgeX, statusBadgeY, 50, 18, 5)
         .fill(colors.success);
      
      doc.fontSize(8)
         .fillColor('#ffffff')
         .font(fonts.bold)
         .text('PAID', statusBadgeX, statusBadgeY + 4, { width: 50, align: 'center' });

      currentY += 110;

      doc.roundedRect(50, currentY, 495, 28, 8)
         .fillAndStroke(colors.cardBg, colors.border);

      const tableHeaderY = currentY + 9;
      doc.fontSize(8)
         .fillColor(colors.primary)
         .font(fonts.bold)
         .text('PRODUCT', 65, tableHeaderY, { width: 220 })
         .text('TYPE', 285, tableHeaderY, { width: 80, align: 'center' })
         .text('ORIGINAL', 365, tableHeaderY, { width: 70, align: 'right' })
         .text('PAID', 435, tableHeaderY, { width: 95, align: 'right' });

      currentY += 35;

      const maxProductsPerPage = Math.min(payment.products.length, 7);
      
for (let i = 0; i < maxProductsPerPage; i++) {
  const product = payment.products[i];
  const productType = getProductTypeLabel(product);
  
  if (i % 2 === 0) {
    doc.rect(50, currentY - 4, 495, 32)
       .fill(colors.cardBg);
  }

  doc.fontSize(9)
     .fillColor(colors.text)
     .font(fonts.regular)
     .text(product.name, 65, currentY + 6, { width: 220, ellipsis: true });

  doc.fontSize(7.5)
     .fillColor(colors.lightText)
     .text(productType, 285, currentY + 7, { width: 80, align: 'center' });

  if (product.salePrice) {
    doc.fontSize(8.5)
       .fillColor(colors.lightText)
       .font(fonts.regular)
       .text(`${globalSettings.currencySymbol}${product.originalPrice.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`, 
         365, currentY + 6, { width: 70, align: 'right', strike: true });
  } else {
    doc.fontSize(8.5)
       .fillColor(colors.lightText)
       .font(fonts.regular)
       .text(`${globalSettings.currencySymbol}${product.originalPrice.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`, 
         365, currentY + 6, { width: 70, align: 'right' });
  }

  doc.fontSize(9.5)
     .fillColor(colors.text)
     .font(fonts.bold)
     .text(`${globalSettings.currencySymbol}${product.price.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`, 
       435, currentY + 6, { width: 95, align: 'right' });

  currentY += 32;
}

      if (payment.products.length > maxProductsPerPage) {
        doc.fontSize(7.5)
           .fillColor(colors.lightText)
           .font(fonts.oblique)
           .text(`+${payment.products.length - maxProductsPerPage} more product(s)`, 65, currentY, { width: 220 });
        currentY += 18;
      }

      currentY += 12;

      doc.rect(50, currentY, 495, 1).fill(colors.border);
      currentY += 18;

      const summaryBoxY = currentY;
      const summaryBoxHeight = payment.discountAmount > 0 || payment.salesTaxAmount > 0 ? 110 : 80;
      doc.roundedRect(305, summaryBoxY, 245, summaryBoxHeight, 8)
         .fillAndStroke(colors.cardBg, colors.border);

      let summaryY = summaryBoxY + 18;
      const summaryLabelX = 320;
      const summaryValueX = 465;

      doc.fontSize(8.5)
         .fillColor(colors.lightText)
         .font(fonts.regular)
         .text('Subtotal:', summaryLabelX, summaryY);
      
      doc.fillColor(colors.text)
         .text(`${globalSettings.currencySymbol}${payment.originalSubtotal.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`, 
           summaryValueX, summaryY, { align: 'right', width: 70 });

      if (payment.discountAmount > 0) {
        summaryY += 16;
        doc.fillColor(colors.lightText)
           .text('Discount:', summaryLabelX, summaryY);
        
        doc.fillColor(colors.success)
           .text(`-${globalSettings.currencySymbol}${payment.discountAmount.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`, 
             summaryValueX, summaryY, { align: 'right', width: 70 });
      }

      if (payment.salesTaxAmount > 0) {
        summaryY += 16;
        doc.fillColor(colors.lightText)
           .text('Tax:', summaryLabelX, summaryY);
        
        doc.fillColor(colors.text)
           .text(`${globalSettings.currencySymbol}${payment.salesTaxAmount.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`, 
             summaryValueX, summaryY, { align: 'right', width: 70 });
      }

      summaryY += 18;
      doc.rect(320, summaryY, 215, 1).fill(colors.border);
      summaryY += 14;

      doc.fontSize(10)
         .fillColor(colors.primary)
         .font(fonts.bold)
         .text('TOTAL:', summaryLabelX, summaryY);
      
      doc.fillColor(colors.text)
         .fontSize(12)
         .text(`${globalSettings.currencySymbol}${payment.totalPaid.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`, 
           summaryValueX, summaryY, { align: 'right', width: 70 });

      currentY = summaryBoxY + summaryBoxHeight + 18;
      
      doc.roundedRect(50, currentY, 495, 50, 8)
         .fillAndStroke(colors.cardBg, colors.border);

      doc.fontSize(7.5)
         .fillColor(colors.lightText)
         .font(fonts.regular)
         .text('Verify this invoice online:', 65, currentY + 12);
         
      doc.fillColor(colors.primary)
         .font(fonts.regular)
         .text(`${config.baseURL}/invoice/${payment.transactionID}`, 65, currentY + 24, { 
           link: `${config.baseURL}/invoice/${payment.transactionID}`,
           underline: true
         });
         
      doc.fillColor(colors.veryLightText)
         .fontSize(7)
         .text('This invoice serves as proof of purchase for digital products. Download access is provided through your account.', 
           65, currentY + 36, { width: 465 });

      const footerY = currentY + 60;
      doc.fontSize(7)
         .fillColor(colors.veryLightText)
         .font(fonts.regular)
         .text(
           `${globalSettings.storeName} • Invoice #${payment.ID} • ${moment(payment.createdAt).format('MMMM D, YYYY')}`,
           50, footerY, 
           { align: 'center', width: 495 }
         );

      doc.end();
    } catch (error) {
      console.error('Error generating invoice PDF:', error);
      reject(error);
    }
  });
}

function getProductTypeLabel(product) {
  const productType = product.productType || '';
  
  switch (productType) {
    case 'digital':
    case 'digitalFree':
      return 'Digital';
    case 'serials':
      return 'Serial Key';
    case 'service':
      return 'Service';
    default:
      return 'Product';
  }
}

exports.sendVerificationEmail = async function(user, verificationToken, config, globalSettings) {
  try {
    const emailConfig = globalSettings.emailSettings;
    
    if (!emailConfig || !emailConfig.enabled) {
      console.log('Email sending is disabled');
      return false;
    }
    
    const verificationUrl = `${config.baseURL}/verify-email/${verificationToken}`;
    
    const emailContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body {
          margin: 0;
          padding: 0;
          font-family: 'Arial', sans-serif;
          background-color: #0a0a0a;
        }
        .email-container {
          max-width: 600px;
          margin: 0 auto;
          background-color: #0a0a0a;
        }
        .header {
          background: linear-gradient(135deg, ${globalSettings.accentColor}40 0%, #0a0a0a 100%);
          padding: 40px 20px;
          text-align: center;
          border-bottom: 3px solid ${globalSettings.accentColor};
        }
        .logo {
          width: 80px;
          height: 80px;
          margin: 0 auto 20px;
          border-radius: 16px;
          box-shadow: 0 8px 24px ${globalSettings.accentColor}40;
        }
        .header h1 {
          color: #ffffff;
          font-size: 28px;
          margin: 0;
          font-weight: 700;
        }
        .content {
          background-color: #1a1a1a;
          padding: 40px 30px;
          border-radius: 12px;
          margin: 20px;
          border: 1px solid ${globalSettings.accentColor}30;
        }
        .greeting {
          color: #ffffff;
          font-size: 18px;
          margin-bottom: 20px;
          font-weight: 600;
        }
        .message {
          color: #a1a1aa;
          font-size: 16px;
          line-height: 1.6;
          margin-bottom: 30px;
        }
        .button-container {
          text-align: center;
          margin: 35px 0;
        }
        .verify-button {
          display: inline-block;
          padding: 16px 48px;
          background-color: ${globalSettings.accentColor};
          color: #ffffff !important;
          text-decoration: none;
          border-radius: 12px;
          font-size: 16px;
          font-weight: 700;
          box-shadow: 0 4px 16px ${globalSettings.accentColor}40;
          transition: all 0.3s ease;
        }
        .verify-button:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 20px ${globalSettings.accentColor}60;
        }
        .info-box {
          background-color: #0a0a0a;
          border: 1px solid ${globalSettings.accentColor}40;
          border-radius: 8px;
          padding: 20px;
          margin: 25px 0;
        }
        .info-box p {
          color: #71717a;
          font-size: 14px;
          margin: 8px 0;
          line-height: 1.5;
        }
        .info-box strong {
          color: ${globalSettings.accentColor};
        }
        .alternative-link {
          background-color: #0a0a0a;
          border: 1px solid #2a2a2a;
          border-radius: 8px;
          padding: 15px;
          margin: 25px 0;
          text-align: center;
        }
        .alternative-link p {
          color: #71717a;
          font-size: 13px;
          margin: 8px 0;
        }
        .alternative-link a {
          color: ${globalSettings.accentColor};
          text-decoration: none;
          word-break: break-all;
          font-size: 12px;
        }
        .footer {
          text-align: center;
          padding: 30px 20px;
          color: #71717a;
          font-size: 13px;
        }
        .footer a {
          color: ${globalSettings.accentColor};
          text-decoration: none;
        }
        .warning {
          background-color: #ef444410;
          border: 1px solid #ef444430;
          border-radius: 8px;
          padding: 15px;
          margin: 25px 0;
        }
        .warning p {
          color: #ef4444;
          font-size: 13px;
          margin: 0;
          line-height: 1.5;
        }
      </style>
    </head>
    <body>
      <div class="email-container">
        <div class="header">
          <div class="logo">
            <img src="${config.baseURL}${globalSettings.logoPath}" alt="${globalSettings.storeName}" style="width: 80px; height: 80px; border-radius: 16px;">
          </div>
          <h1>Verify Your Email</h1>
        </div>
        
        <div class="content">
          <p class="greeting">Hello ${user.username}!</p>
          
          <p class="message">
            Thank you for creating an account with <strong style="color: ${globalSettings.accentColor};">${globalSettings.storeName}</strong>. 
            We're excited to have you on board! To get started, please verify your email address by clicking the button below.
          </p>
          
          <div class="button-container">
            <a href="${verificationUrl}" class="verify-button">Verify Email Address</a>
          </div>
          
          <div class="info-box">
            <p><strong>Security Information:</strong></p>
            <p>• This verification link will expire in <strong>24 hours</strong></p>
            <p>• You can only use this link once</p>
            <p>• If you didn't create an account, please ignore this email</p>
          </div>
          
          <div class="alternative-link">
            <p>Button not working? Copy and paste this link into your browser:</p>
            <a href="${verificationUrl}">${verificationUrl}</a>
          </div>
          
          <div class="warning">
            <p><strong>⚠️ Security Notice:</strong> Never share this verification link with anyone. ${globalSettings.storeName} staff will never ask you for this link.</p>
          </div>
        </div>
        
        <div class="footer">
          <p>This email was sent to <strong>${user.email}</strong></p>
          <p>
            <a href="${config.baseURL}">${globalSettings.storeName}</a> • 
          </p>
          <p style="margin-top: 15px; color: #71717a;">
            © ${new Date().getFullYear()} ${globalSettings.storeName}. All rights reserved.
          </p>
        </div>
      </div>
    </body>
    </html>
    `;

    const emailSubject = `Verify Your Email - ${globalSettings.storeName}`;
    
    if (emailConfig.provider === "sendgrid") {
      const sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(emailConfig.sendGrid.token);
      
      const msg = {
        to: user.email,
        from: emailConfig.fromEmail,
        subject: emailSubject,
        html: emailContent
      };
      
      await sgMail.send(msg);
    } else if (emailConfig.provider === "smtp") {
      const transporter = nodemailer.createTransport({
        host: emailConfig.smtp.host,
        port: emailConfig.smtp.port,
        secure: emailConfig.smtp.secure,
        auth: {
          user: emailConfig.smtp.user,
          pass: emailConfig.smtp.password,
        },
      });
      
      const mailOptions = {
        from: emailConfig.fromEmail,
        to: user.email,
        subject: emailSubject,
        html: emailContent
      };
      
      await transporter.sendMail(mailOptions);
    }
    
    console.log(`Verification email sent to ${user.email}`);
    return true;
  } catch (error) {
    console.error('Error sending verification email:', error);
    throw error;
  }
};

exports.sendPasswordResetEmail = async function(user, resetToken, config, globalSettings) {
  try {
    const resetUrl = `${config.baseURL}/reset-password/${resetToken}`;
    
    const emailContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body {
          margin: 0;
          padding: 0;
          font-family: 'Arial', sans-serif;
          background-color: #0a0a0a;
        }
        .email-container {
          max-width: 600px;
          margin: 0 auto;
          background-color: #0a0a0a;
        }
        .header {
          background: linear-gradient(135deg, ${globalSettings.accentColor}40 0%, #0a0a0a 100%);
          padding: 40px 20px;
          text-align: center;
          border-bottom: 3px solid ${globalSettings.accentColor};
        }
        .logo {
          width: 80px;
          height: 80px;
          margin: 0 auto 20px;
          border-radius: 16px;
          box-shadow: 0 8px 24px ${globalSettings.accentColor}40;
        }
        .header h1 {
          color: #ffffff;
          font-size: 28px;
          margin: 0;
          font-weight: 700;
        }
        .content {
          background-color: #1a1a1a;
          padding: 40px 30px;
          border-radius: 12px;
          margin: 20px;
          border: 1px solid ${globalSettings.accentColor}30;
        }
        .greeting {
          color: #ffffff;
          font-size: 18px;
          margin-bottom: 20px;
          font-weight: 600;
        }
        .message {
          color: #a1a1aa;
          font-size: 16px;
          line-height: 1.6;
          margin-bottom: 30px;
        }
        .button-container {
          text-align: center;
          margin: 35px 0;
        }
        .reset-button {
          display: inline-block;
          padding: 16px 48px;
          background-color: ${globalSettings.accentColor};
          color: #ffffff !important;
          text-decoration: none;
          border-radius: 12px;
          font-size: 16px;
          font-weight: 700;
          box-shadow: 0 4px 16px ${globalSettings.accentColor}40;
          transition: all 0.3s ease;
        }
        .reset-button:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 20px ${globalSettings.accentColor}60;
        }
        .info-box {
          background-color: #0a0a0a;
          border: 1px solid ${globalSettings.accentColor}40;
          border-radius: 8px;
          padding: 20px;
          margin: 25px 0;
        }
        .info-box p {
          color: #71717a;
          font-size: 14px;
          margin: 8px 0;
          line-height: 1.5;
        }
        .info-box strong {
          color: ${globalSettings.accentColor};
        }
        .alternative-link {
          background-color: #0a0a0a;
          border: 1px solid #2a2a2a;
          border-radius: 8px;
          padding: 15px;
          margin: 25px 0;
          text-align: center;
        }
        .alternative-link p {
          color: #71717a;
          font-size: 13px;
          margin: 8px 0;
        }
        .alternative-link a {
          color: ${globalSettings.accentColor};
          text-decoration: none;
          word-break: break-all;
          font-size: 12px;
        }
        .footer {
          text-align: center;
          padding: 30px 20px;
          color: #71717a;
          font-size: 13px;
        }
        .footer a {
          color: ${globalSettings.accentColor};
          text-decoration: none;
        }
        .warning {
          background-color: #ef444410;
          border: 1px solid #ef444430;
          border-radius: 8px;
          padding: 15px;
          margin: 25px 0;
        }
        .warning p {
          color: #ef4444;
          font-size: 13px;
          margin: 0;
          line-height: 1.5;
        }
      </style>
    </head>
    <body>
      <div class="email-container">
        <div class="header">
          <div class="logo">
            <img src="${config.baseURL}${globalSettings.logoPath}" alt="${globalSettings.storeName}" style="width: 80px; height: 80px; border-radius: 16px;">
          </div>
          <h1>Reset Your Password</h1>
        </div>
        
        <div class="content">
          <p class="greeting">Hello ${user.username || user.email.split('@')[0]}!</p>
          
          <p class="message">
            We received a request to reset the password for your <strong style="color: ${globalSettings.accentColor};">${globalSettings.storeName}</strong> account. 
            Click the button below to choose a new password.
          </p>
          
          <div class="button-container">
            <a href="${resetUrl}" class="reset-button">Reset Password</a>
          </div>
          
          <div class="info-box">
            <p><strong>Security Information:</strong></p>
            <p>• This password reset link will expire in <strong>1 hour</strong></p>
            <p>• You can only use this link once</p>
            <p>• If you didn't request a password reset, please ignore this email</p>
          </div>
          
          <div class="alternative-link">
            <p>Button not working? Copy and paste this link into your browser:</p>
            <a href="${resetUrl}">${resetUrl}</a>
          </div>
          
          <div class="warning">
            <p><strong>⚠️ Security Notice:</strong> Never share this password reset link with anyone. ${globalSettings.storeName} staff will never ask you for this link.</p>
          </div>
        </div>
        
        <div class="footer">
          <p>This email was sent to <strong>${user.email}</strong></p>
          <p>
            <a href="${config.baseURL}">${globalSettings.storeName}</a> • 
          </p>
          <p style="margin-top: 15px; color: #71717a;">
            © ${new Date().getFullYear()} ${globalSettings.storeName}. All rights reserved.
          </p>
        </div>
      </div>
    </body>
    </html>
    `;

const emailSubject = `Reset Your Password - ${globalSettings.storeName}`;

const emailConfig = globalSettings.emailSettings;

if (!emailConfig || !emailConfig.enabled) {
  console.log('Email sending is disabled');
  return false;
}

if (emailConfig.provider === "sendgrid") {
  const sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(emailConfig.sendGrid.token);
  
  const msg = {
    to: user.email,
    from: emailConfig.fromEmail,
    subject: emailSubject,
    html: emailContent
  };
  
  await sgMail.send(msg);
} else if (emailConfig.provider === "smtp") {
  const transporter = nodemailer.createTransport({
    host: emailConfig.smtp.host,
    port: emailConfig.smtp.port,
    secure: emailConfig.smtp.secure,
    auth: {
      user: emailConfig.smtp.user,
      pass: emailConfig.smtp.password,
    },
  });
  
  const mailOptions = {
    from: emailConfig.fromEmail,
    to: user.email,
    subject: emailSubject,
    html: emailContent
  };
  
  await transporter.sendMail(mailOptions);
}
    
    console.log(`Password reset email sent to ${user.email}`);
    return true;
  } catch (error) {
    console.error('Error sending password reset email:', error);
    throw error;
  }
};

exports.sendEmailChangeEmail = async function(user, emailChangeToken, newEmail, config, globalSettings) {
  try {
    const verificationUrl = `${config.baseURL}/verify-email-change/${emailChangeToken}`;
    
    const emailContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body {
          margin: 0;
          padding: 0;
          font-family: 'Arial', sans-serif;
          background-color: #0a0a0a;
        }
        .email-container {
          max-width: 600px;
          margin: 0 auto;
          background-color: #0a0a0a;
        }
        .header {
          background: linear-gradient(135deg, ${globalSettings.accentColor}40 0%, #0a0a0a 100%);
          padding: 40px 20px;
          text-align: center;
          border-bottom: 3px solid ${globalSettings.accentColor};
        }
        .logo {
          width: 80px;
          height: 80px;
          margin: 0 auto 20px;
          border-radius: 16px;
          box-shadow: 0 8px 24px ${globalSettings.accentColor}40;
        }
        .header h1 {
          color: #ffffff;
          font-size: 28px;
          margin: 0;
          font-weight: 700;
        }
        .content {
          background-color: #1a1a1a;
          padding: 40px 30px;
          border-radius: 12px;
          margin: 20px;
          border: 1px solid ${globalSettings.accentColor}30;
        }
        .greeting {
          color: #ffffff;
          font-size: 18px;
          margin-bottom: 20px;
          font-weight: 600;
        }
        .message {
          color: #a1a1aa;
          font-size: 16px;
          line-height: 1.6;
          margin-bottom: 30px;
        }
        .button-container {
          text-align: center;
          margin: 35px 0;
        }
        .verify-button {
          display: inline-block;
          padding: 16px 48px;
          background-color: ${globalSettings.accentColor};
          color: #ffffff !important;
          text-decoration: none;
          border-radius: 12px;
          font-size: 16px;
          font-weight: 700;
          box-shadow: 0 4px 16px ${globalSettings.accentColor}40;
        }
        .info-box {
          background-color: #0a0a0a;
          border: 1px solid ${globalSettings.accentColor}40;
          border-radius: 8px;
          padding: 20px;
          margin: 25px 0;
        }
        .info-box p {
          color: #71717a;
          font-size: 14px;
          margin: 8px 0;
          line-height: 1.5;
        }
        .info-box strong {
          color: ${globalSettings.accentColor};
        }
        .email-highlight {
          background-color: #0a0a0a;
          border: 1px solid ${globalSettings.accentColor}40;
          border-radius: 8px;
          padding: 15px;
          margin: 20px 0;
          text-align: center;
        }
        .email-highlight p {
          margin: 0;
          color: ${globalSettings.accentColor};
          font-size: 16px;
          font-weight: 600;
        }
        .alternative-link {
          background-color: #0a0a0a;
          border: 1px solid #2a2a2a;
          border-radius: 8px;
          padding: 15px;
          margin: 25px 0;
          text-align: center;
        }
        .alternative-link p {
          color: #71717a;
          font-size: 13px;
          margin: 8px 0;
        }
        .alternative-link a {
          color: ${globalSettings.accentColor};
          text-decoration: none;
          word-break: break-all;
          font-size: 12px;
        }
        .footer {
          text-align: center;
          padding: 30px 20px;
          color: #71717a;
          font-size: 13px;
        }
        .footer a {
          color: ${globalSettings.accentColor};
          text-decoration: none;
        }
        .warning {
          background-color: #ef444410;
          border: 1px solid #ef444430;
          border-radius: 8px;
          padding: 15px;
          margin: 25px 0;
        }
        .warning p {
          color: #ef4444;
          font-size: 13px;
          margin: 0;
          line-height: 1.5;
        }
      </style>
    </head>
    <body>
      <div class="email-container">
        <div class="header">
          <div class="logo">
            <img src="${config.baseURL}${globalSettings.logoPath}" alt="${globalSettings.storeName}" style="width: 80px; height: 80px; border-radius: 16px;">
          </div>
          <h1>Verify Email Change</h1>
        </div>
        
        <div class="content">
          <p class="greeting">Hello ${user.username || 'there'}!</p>
          
          <p class="message">
            You requested to change the email address for your <strong style="color: ${globalSettings.accentColor};">${globalSettings.storeName}</strong> account. 
            Please verify your new email address by clicking the button below.
          </p>
          
          <div class="email-highlight">
            <p>New Email: ${newEmail}</p>
          </div>
          
          <div class="button-container">
            <a href="${verificationUrl}" class="verify-button">Verify New Email</a>
          </div>
          
          <div class="info-box">
            <p><strong>Security Information:</strong></p>
            <p>• This verification link will expire in <strong>1 hour</strong></p>
            <p>• You can only use this link once</p>
            <p>• Your email won't change until you verify this link</p>
            <p>• If you didn't request this change, please ignore this email</p>
          </div>
          
          <div class="alternative-link">
            <p>Button not working? Copy and paste this link into your browser:</p>
            <a href="${verificationUrl}">${verificationUrl}</a>
          </div>
          
          <div class="warning">
            <p><strong>⚠️ Security Notice:</strong> Never share this verification link with anyone. ${globalSettings.storeName} staff will never ask you for this link.</p>
          </div>
        </div>
        
        <div class="footer">
          <p>This email was sent to <strong>${newEmail}</strong></p>
          <p>
            <a href="${config.baseURL}">${globalSettings.storeName}</a> • 
          </p>
          <p style="margin-top: 15px; color: #71717a;">
            © ${new Date().getFullYear()} ${globalSettings.storeName}. All rights reserved.
          </p>
        </div>
      </div>
    </body>
    </html>
    `;

const emailSubject = `Verify Your New Email Address - ${globalSettings.storeName}`;

const emailConfig = globalSettings.emailSettings;

if (!emailConfig || !emailConfig.enabled) {
  console.log('Email sending is disabled');
  return false;
}

if (emailConfig.provider === "sendgrid") {
  const sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(emailConfig.sendGrid.token);
  
  const msg = {
    to: newEmail,
    from: emailConfig.fromEmail,
    subject: emailSubject,
    html: emailContent
  };
  
  await sgMail.send(msg);
} else if (emailConfig.provider === "smtp") {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: emailConfig.smtp.host,
    port: emailConfig.smtp.port,
    secure: emailConfig.smtp.secure,
    auth: {
      user: emailConfig.smtp.user,
      pass: emailConfig.smtp.password,
    },
  });
  
  const mailOptions = {
    from: emailConfig.fromEmail,
    to: newEmail,
    subject: emailSubject,
    html: emailContent
  };
  
  await transporter.sendMail(mailOptions);
}
    
    console.log(`Email change verification sent to ${newEmail}`);
    return true;
  } catch (error) {
    console.error('Error sending email change verification:', error);
    throw error;
  }
};

exports.sendInvoiceEmail = async function(payment, user, products, config, globalSettings, existingPdfBuffer = null) {
  try {
    const pdfBuffer = existingPdfBuffer || await this.generateInvoicePdf({
      payment,
      config,
      globalSettings
    });

    const savedPath = payment.invoicePath || await this.saveInvoicePdf(pdfBuffer, payment);
    
    const emailContent = await this.generateEmailContent({
      paymentMethod: payment.paymentMethod.charAt(0).toUpperCase() + payment.paymentMethod.slice(1),
      transactionId: payment.transactionID,
      userId: payment.userID,
      username: payment.username,
      userEmail: payment.email,
      products: payment.products,
      totalPaid: payment.totalPaid,
      discountCode: payment.discountCode,
      discountPercentage: payment.discountPercentage,
      salesTax: payment.salesTax,
      salesTaxAmount: payment.salesTaxAmount,
      nextPaymentId: payment.ID,
      globalSettings,
      config,
      invoicePath: savedPath ? `${config.baseURL}/${savedPath}` : null
    });

const emailSubject = `Your Payment Invoice (#${payment.ID}) - ${globalSettings.storeName}`;

const emailConfig = globalSettings.emailSettings;

if (!emailConfig || !emailConfig.enabled) {
  console.log('Email sending is disabled');
  return false;
}

if (emailConfig.provider === "sendgrid") {
  const sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(emailConfig.sendGrid.token);
  
  const msg = {
    to: payment.email,
    from: emailConfig.fromEmail,
    subject: emailSubject,
    html: emailContent,
    attachments: [
      {
        content: pdfBuffer.toString('base64'),
        filename: `invoice-${payment.ID}.pdf`,
        type: 'application/pdf',
        disposition: 'attachment'
      }
    ]
  };
  
  await sgMail.send(msg);
} else if (emailConfig.provider === "smtp") {
  const transporter = nodemailer.createTransport({
    host: emailConfig.smtp.host,
    port: emailConfig.smtp.port,
    secure: emailConfig.smtp.secure,
    auth: {
      user: emailConfig.smtp.user,
      pass: emailConfig.smtp.password,
    },
  });
  
  const mailOptions = {
    from: emailConfig.fromEmail,
    to: payment.email,
    subject: emailSubject,
    html: emailContent,
    attachments: [
      {
        filename: `invoice-${payment.ID}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf'
      }
    ]
  };
  
  await transporter.sendMail(mailOptions);
}
    
    console.log(`Successfully sent invoice email with PDF attachment to ${payment.email}`);
    return true;
  } catch (error) {
    console.error('Error sending invoice email with PDF attachment:', error);
    return false;
  }
};
  
exports.generateEmailContent = async function ({
  paymentMethod,
  transactionId,
  userId,
  username,
  userEmail,
  discordId = null,
  products,
  totalPaid,
  discountCode = null,
  discountPercentage = null,
  salesTax = null,
  salesTaxAmount = null,
  nextPaymentId,
  globalSettings,
  config,
}) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body {
        margin: 0;
        padding: 0;
        font-family: 'Arial', sans-serif;
        background-color: #0a0a0a;
      }
      .email-container {
        max-width: 600px;
        margin: 0 auto;
        background-color: #0a0a0a;
      }
      .header {
        background: linear-gradient(135deg, ${globalSettings.accentColor}40 0%, #0a0a0a 100%);
        padding: 40px 20px;
        text-align: center;
        border-bottom: 3px solid ${globalSettings.accentColor};
      }
      .logo {
        width: 80px;
        height: 80px;
        margin: 0 auto 20px;
        border-radius: 16px;
        box-shadow: 0 8px 24px ${globalSettings.accentColor}40;
      }
      .header h1 {
        color: #ffffff;
        font-size: 28px;
        margin: 0;
        font-weight: 700;
      }
      .content {
        background-color: #1a1a1a;
        padding: 40px 30px;
        border-radius: 12px;
        margin: 20px;
        border: 1px solid ${globalSettings.accentColor}30;
      }
      .greeting {
        color: #ffffff;
        font-size: 18px;
        margin-bottom: 20px;
        font-weight: 600;
      }
      .message {
        color: #a1a1aa;
        font-size: 16px;
        line-height: 1.6;
        margin-bottom: 30px;
      }
      .invoice-details {
        background-color: #0a0a0a;
        border: 1px solid ${globalSettings.accentColor}40;
        border-radius: 8px;
        padding: 20px;
        margin: 25px 0;
      }
      .invoice-details p {
        color: #71717a;
        font-size: 14px;
        margin: 8px 0;
        line-height: 1.5;
      }
      .invoice-details strong {
        color: ${globalSettings.accentColor};
      }
      .invoice-id {
        background: linear-gradient(135deg, ${globalSettings.accentColor}20 0%, transparent 100%);
        border: 1px solid ${globalSettings.accentColor}40;
        border-radius: 8px;
        padding: 20px;
        margin: 25px 0;
        text-align: center;
      }
      .invoice-id h2 {
        color: #ffffff;
        font-size: 24px;
        margin: 0 0 8px 0;
        font-weight: 700;
      }
      .invoice-id p {
        color: ${globalSettings.accentColor};
        font-size: 32px;
        margin: 0;
        font-weight: 700;
      }
      .products-section {
        margin: 30px 0;
      }
      .products-section h3 {
        color: #ffffff;
        font-size: 18px;
        margin-bottom: 15px;
        font-weight: 600;
        border-bottom: 2px solid ${globalSettings.accentColor};
        padding-bottom: 10px;
      }
      .product-item {
        background-color: #0a0a0a;
        border: 1px solid #2a2a2a;
        border-radius: 8px;
        padding: 15px;
        margin-bottom: 10px;
      }
      .product-name {
        color: #ffffff;
        font-size: 15px;
        font-weight: 600;
        margin-bottom: 5px;
      }
      .product-price {
        color: ${globalSettings.accentColor};
        font-size: 16px;
        font-weight: 700;
        float: right;
      }
      .total-section {
        background: linear-gradient(135deg, ${globalSettings.accentColor}15 0%, #0a0a0a 100%);
        border: 2px solid ${globalSettings.accentColor};
        border-radius: 12px;
        padding: 20px;
        margin: 25px 0;
      }
      .total-row {
        display: flex;
        justify-content: space-between;
        margin: 10px 0;
        color: #a1a1aa;
        font-size: 14px;
      }
      .total-row.main {
        border-top: 2px solid ${globalSettings.accentColor}40;
        padding-top: 15px;
        margin-top: 15px;
      }
      .total-row.main .label {
        color: #ffffff;
        font-size: 18px;
        font-weight: 700;
      }
      .total-row.main .value {
        color: ${globalSettings.accentColor};
        font-size: 22px;
        font-weight: 700;
      }
      .total-row .value {
        font-weight: 600;
        color: #ffffff;
      }
      .total-row.discount .value {
        color: #10b981;
      }
      .button-container {
        text-align: center;
        margin: 35px 0;
      }
      .invoice-button {
        display: inline-block;
        padding: 16px 48px;
        background-color: ${globalSettings.accentColor};
        color: #ffffff !important;
        text-decoration: none;
        border-radius: 12px;
        font-size: 16px;
        font-weight: 700;
        box-shadow: 0 4px 16px ${globalSettings.accentColor}40;
      }
      .info-box {
        background-color: #0a0a0a;
        border: 1px solid ${globalSettings.accentColor}40;
        border-radius: 8px;
        padding: 20px;
        margin: 25px 0;
      }
      .info-box p {
        color: #71717a;
        font-size: 14px;
        margin: 8px 0;
        line-height: 1.5;
      }
      .info-box strong {
        color: ${globalSettings.accentColor};
      }
      .footer {
        text-align: center;
        padding: 30px 20px;
        color: #71717a;
        font-size: 13px;
      }
      .footer a {
        color: ${globalSettings.accentColor};
        text-decoration: none;
      }
      .success-badge {
        display: inline-block;
        background-color: #10b981;
        color: #ffffff;
        padding: 6px 16px;
        border-radius: 20px;
        font-size: 12px;
        font-weight: 700;
        margin-bottom: 15px;
      }
    </style>
  </head>
  <body>
    <div class="email-container">
      <div class="header">
        <div class="logo">
          <img src="${config.baseURL}${globalSettings.logoPath}" alt="${globalSettings.storeName}" style="width: 80px; height: 80px; border-radius: 16px;">
        </div>
        <h1>Payment Invoice</h1>
      </div>
      
      <div class="content">
        <p class="greeting">Hello ${username}!</p>
        
        <div class="success-badge">✓ PAYMENT SUCCESSFUL</div>
        
        <p class="message">
          Thank you for your purchase at <strong style="color: ${globalSettings.accentColor};">${globalSettings.storeName}</strong>. 
          Your payment has been processed successfully. Below you'll find the complete details of your transaction.
        </p>

        <div class="invoice-id">
          <h2>Invoice Number</h2>
          <p>#${nextPaymentId}</p>
        </div>
        
        <div class="invoice-details">
          <p><strong>Transaction Details:</strong></p>
          <p>• <strong>Transaction ID:</strong> ${transactionId}</p>
          <p>• <strong>Payment Method:</strong> ${paymentMethod}</p>
          <p>• <strong>User ID:</strong> ${userId}</p>
          <p>• <strong>Username:</strong> ${username}</p>
          <p>• <strong>Email:</strong> ${userEmail}</p>
          ${discordId ? `<p>• <strong>Discord ID:</strong> ${discordId}</p>` : ''}
        </div>

        <div class="products-section">
          <h3>Order Items</h3>
          ${products.map(product => `
            <div class="product-item">
              <div class="product-name">${product.name}</div>
              <div class="product-price">
                ${globalSettings.currencySymbol}${product.price.toFixed(2)}
              </div>
            </div>
          `).join('')}
        </div>

        <div class="total-section">
          ${discountCode ? `
            <div class="total-row discount">
              <span class="label">Discount (${discountCode} - ${discountPercentage}%):</span>
              <span class="value">Applied</span>
            </div>
          ` : ''}
          ${salesTax ? `
            <div class="total-row">
              <span class="label">Sales Tax (${salesTax}%):</span>
              <span class="value">${globalSettings.currencySymbol}${salesTaxAmount.toFixed(2)}</span>
            </div>
          ` : ''}
          <div class="total-row main">
            <span class="label">Total Paid:</span>
            <span class="value">${globalSettings.currencySymbol}${totalPaid.toFixed(2)}</span>
          </div>
        </div>

        <div class="button-container">
          <a href="${config.baseURL}/invoice/${transactionId}" class="invoice-button">View Invoice Online</a>
        </div>
        
        <div class="info-box">
          <p><strong>Important Information:</strong></p>
          <p>• A PDF copy of this invoice is attached to this email</p>
          <p>• You can access your purchased products from your account dashboard</p>
          <p>• Download links are available immediately in your purchases section</p>
        </div>
      </div>
      
      <div class="footer">
        <p>This invoice was sent to <strong>${userEmail}</strong></p>
        <p>
          <a href="${config.baseURL}">${globalSettings.storeName}</a> • 
          <a href="${config.baseURL}/invoice/${transactionId}">View Online</a>
        </p>
        <p style="margin-top: 15px; color: #71717a;">
          © ${new Date().getFullYear()} ${globalSettings.storeName}. All rights reserved.
        </p>
      </div>
    </div>
  </body>
  </html>
  `;
};

  exports.saveInvoicePdf = async function(pdfBuffer, payment) {
    try {
      const invoicesDir = path.join(__dirname, 'uploads', 'invoices');
      if (!fsSync.existsSync(invoicesDir)) {
        fsSync.mkdirSync(invoicesDir, { recursive: true });
      }
      
      const userDir = path.join(invoicesDir, payment.userID.toString());
      if (!fsSync.existsSync(userDir)) {
        fsSync.mkdirSync(userDir, { recursive: true });
      }
      
      const filename = `invoice-${payment.ID}-${payment.transactionID}.pdf`;
      const filepath = path.join(userDir, filename);
      
      fsSync.writeFileSync(filepath, pdfBuffer);
      
      const relativePath = path.join('uploads', 'invoices', payment.userID.toString(), filename).replace(/\\/g, '/');
    
      payment.invoicePath = relativePath;
      await payment.save();
      
      console.log(`Invoice PDF saved to ${relativePath}`);
      return relativePath;
    } catch (error) {
      console.error('Error saving invoice PDF:', error);
      return null;
    }
  };

  exports.loadInvoicePdf = function(invoicePath) {
    try {
      const fullPath = path.join(__dirname, invoicePath);
      if (fsSync.existsSync(fullPath)) {
        return fsSync.readFileSync(fullPath);
      }
      return null;
    } catch (error) {
      console.error('Error loading invoice PDF:', error);
      return null;
    }
  };

  exports.sendDiscordLog = async function (title, description) {
    try {
      const settings = await settingsModel.findOne();
      const channelId = settings.discordLoggingChannel;
  
      if(!channelId) return console.error('No Discord logging channel ID is set in the settings.');
  
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return console.error('Unable to find the specified Discord channel or the channel is not a text channel.');
  
      const embed = new Discord.EmbedBuilder()
      .setTitle(title || 'Log')
      .setDescription(description || 'Unknown')
      .setTimestamp()
      .setColor(settings.accentColor);

      await channel.send({ embeds: [embed] });
    } catch (error) {
      console.error('Error sending Discord log:', error);
    }
  };
  
exports.scanFileForPlaceholders = async function(filePath) {
    try {
        const placeholderLocations = [];
        const placeholderRegex = /%%__(\w+)__%%/g;
        let hasPlaceholders = false;

        const fileStats = await fs.stat(filePath);
        
        if (fileStats.size > 5 * 1024 * 1024 * 1024) {
            console.warn('File too large for placeholder scanning (>5GB):', filePath);
            return { hasPlaceholders: false, locations: [] };
        }

        function checkContentForPlaceholders(content, filePath, isBinary = false) {
            let found = false;
            
            if (isBinary) {
                const bufferStr = content.toString('binary');
                if (placeholderRegex.test(bufferStr)) {
                    found = true;
                }
            } else {
                if (placeholderRegex.test(content)) {
                    found = true;
                }
            }
            
            return found;
        }

        async function scanArchiveForPlaceholders(archivePath, parentPath = '') {
            return new Promise((resolve) => {
                const localLocations = [];
                let resolved = false;

                const resolveOnce = (result) => {
                    if (!resolved) {
                        resolved = true;
                        resolve(result);
                    }
                };

                const stream = fsSync.createReadStream(archivePath)
                    .pipe(unzipper.Parse());

                stream.on('entry', (entry) => {
                    if (resolved) {
                        entry.autodrain();
                        return;
                    }

                    const fullPath = parentPath ? `${parentPath}/${entry.path}` : entry.path;
                    const isTextFile = entry.path.match(/\.(txt|js|json|md|yml|yaml|xml|properties|config|java)$/i);
                    const isClassFile = entry.path.match(/\.(class)$/i);
                    const isNestedArchive = entry.path.match(/\.(zip|jar|war)$/i);

                    if (entry.type === 'Directory' || (!isTextFile && !isClassFile && !isNestedArchive)) {
                        entry.autodrain();
                        return;
                    }

                    const chunks = [];
                    let totalSize = 0;
                    const maxChunkSize = 64 * 1024;

                    entry.on('data', (chunk) => {
                        if (totalSize < maxChunkSize) {
                            chunks.push(chunk);
                            totalSize += chunk.length;
                        }
                    });

                    entry.on('end', async () => {
                        try {
                            const content = Buffer.concat(chunks);
                            
                            if (isNestedArchive) {
                                const nestedTempPath = path.join(path.dirname(archivePath), `temp-scan-${Date.now()}-${path.basename(entry.path)}`);
                                await fs.writeFile(nestedTempPath, content);
                                tempFiles.add(nestedTempPath);

                                const nestedLocations = await scanArchiveForPlaceholders(nestedTempPath, fullPath);
                                localLocations.push(...nestedLocations);
                            } else if (isClassFile) {
                                if (checkContentForPlaceholders(content, fullPath, true)) {
                                    localLocations.push({
                                        filePath: fullPath,
                                        isArchive: false,
                                        isBinary: true
                                    });
                                }
                            } else if (isTextFile) {
                                try {
                                    const textContent = content.toString('utf8');
                                    if (checkContentForPlaceholders(textContent, fullPath, false)) {
                                        localLocations.push({
                                            filePath: fullPath,
                                            isArchive: false,
                                            isBinary: false
                                        });
                                    }
                                } catch (e) {
                                }
                            }
                        } catch (e) {
                        }
                    });
                });

                stream.on('finish', () => {
                    resolveOnce(localLocations);
                });

                stream.on('error', () => {
                    resolveOnce(localLocations);
                });

                setTimeout(() => {
                    resolveOnce(localLocations);
                }, 30000);
            });
        }

        if (filePath.match(/\.(zip|jar|war)$/i)) {
            if (config.DebugMode) console.log(`Scanning archive for placeholders: ${filePath}`);
            const locations = await scanArchiveForPlaceholders(filePath);
            
            if (locations.length > 0) {
                hasPlaceholders = true;
                placeholderLocations.push(...locations);
                if (config.DebugMode) console.log(`Found ${locations.length} files with placeholders`);
            }
        } else {
            const content = await fs.readFile(filePath, 'utf8');
            if (checkContentForPlaceholders(content, filePath, false)) {
                hasPlaceholders = true;
                placeholderLocations.push({
                    filePath: path.basename(filePath),
                    isArchive: false,
                    isBinary: false
                });
            }
        }

        return {
            hasPlaceholders,
            locations: placeholderLocations
        };
    } catch (error) {
        console.error('Error scanning file for placeholders:', error);
        return {
            hasPlaceholders: false,
            locations: []
        };
    }
};

exports.processFileWithPlaceholders = async function (filePath, replacements) {
    try {
        let placeholderFound = false;
        const fileStats = await fs.stat(filePath);
        
        if (fileStats.size > 5 * 1024 * 1024 * 1024) {
            console.warn('File too large for placeholder processing (>5GB):', filePath);
            return filePath;
        }
        
        const fileKey = `${filePath}-${fileStats.mtime.getTime()}-${fileStats.size}`;
        if (processedFileCache.has(fileKey)) {
            const cachedResult = processedFileCache.get(fileKey);
            if (fsSync.existsSync(cachedResult)) {
                return cachedResult;
            } else {
                processedFileCache.delete(fileKey);
            }
        }

        function generateUniqueFilename(baseName) {
            const randomBytes = crypto.randomBytes(4).toString('hex');
            const timestamp = Date.now().toString(36);
            return `temp-${timestamp}-${randomBytes}-${baseName}`;
        }

        const placeholderRegex = /%%__(\w+)__%%/g;
        
        function replacePlaceholders(content, replacements) {
            return content.replace(placeholderRegex, (match, placeholder) => {
                if (replacements[placeholder]) {
                    placeholderFound = true;
                    return replacements[placeholder];
                }
                return match;
            });
        }

        function replacePlaceholdersInBinary(buffer, replacements) {
            let modified = false;
            const bufferStr = buffer.toString('binary');
            const newStr = bufferStr.replace(placeholderRegex, (match, placeholder) => {
                if (replacements[placeholder]) {
                    modified = true;
                    placeholderFound = true;
                    return replacements[placeholder];
                }
                return match;
            });
            
            return modified ? Buffer.from(newStr, 'binary') : buffer;
        }

        function shouldProcessArchive(fileName, depth) {
            if (depth === 0) return true;
            if (depth >= 2) return false;
            
            const skipPatterns = [
                /^h2-/i, /^asm-/i, /^gson-/i, /^hikaricp-/i, /^slf4j-/i,
                /^adventure-/i, /^terra-/i, /^bytebuddy-/i, /^caffeine-/i,
                /^commodore-/i, /^okhttp-/i, /^okio-/i, /^jar-relocator-/i,
                /^commons-/i, /^mysql-connector-/i, /^protocollib/i,
                /^junit-/i, /^mockito-/i, /^guava-/i, /^jackson-/i,
                /^netty-/i, /^log4j-/i, /^apache-/i, /^spring-/i,
                /^event-/i, /^examination-/i
            ];
            
            return !skipPatterns.some(pattern => pattern.test(fileName));
        }

        async function quickScanJarForPlaceholders(jarPath) {
            const cacheKey = `${jarPath}-${(await fs.stat(jarPath)).mtime.getTime()}`;
            if (placeholderCache.has(cacheKey)) {
                return placeholderCache.get(cacheKey);
            }

            try {
                return new Promise((resolve) => {
                    let foundPlaceholders = false;
                    let checkedFiles = 0;
                    let resolved = false;
                    const maxFilesToCheck = 50;
                    
                    const resolveOnce = (result) => {
                        if (!resolved) {
                            resolved = true;
                            placeholderCache.set(cacheKey, result);
                            resolve(result);
                        }
                    };
                    
                    const stream = fsSync.createReadStream(jarPath)
                        .pipe(unzipper.Parse());
                    
                    stream.on('entry', (entry) => {
                        if (foundPlaceholders || checkedFiles >= maxFilesToCheck || resolved) {
                            entry.autodrain();
                            return;
                        }
                        
                        if (entry.path.match(/\.(txt|js|json|md|yml|yaml|xml|properties|config|java|class|MF)$/i)) {
                            checkedFiles++;
                            
                            const chunks = [];
                            let totalSize = 0;
                            const maxChunkSize = 64 * 1024;
                            
                            entry.on('data', (chunk) => {
                                if (totalSize < maxChunkSize && !resolved) {
                                    chunks.push(chunk);
                                    totalSize += chunk.length;
                                }
                            });
                            
                            entry.on('end', () => {
                                if (resolved) return;
                                
                                try {
                                    const content = Buffer.concat(chunks);
                                    let hasPlaceholder = false;
                                    
                                    const searchMethods = [
                                        () => {
                                            const textContent = content.toString('utf-8');
                                            return /%%__\w+__%%/.test(textContent);
                                        },
                                        () => {
                                            const binaryString = content.toString('binary');
                                            return /%%__\w+__%%/.test(binaryString);
                                        },
                                        () => {
                                            const latin1Content = content.toString('latin1');
                                            return /%%__\w+__%%/.test(latin1Content);
                                        },
                                        () => {
                                            const hex = content.toString('hex');
                                            return hex.includes('252525') || hex.includes('5f5f');
                                        },
                                        () => {
                                            const ascii = content.toString('ascii');
                                            return /%%__\w+__%%/.test(ascii);
                                        }
                                    ];
                                    
                                    for (const method of searchMethods) {
                                        try {
                                            if (method()) {
                                                hasPlaceholder = true;
                                                break;
                                            }
                                        } catch {}
                                    }
                                    
                                    if (hasPlaceholder) {
                                        foundPlaceholders = true;
                                        resolveOnce(true);
                                        return;
                                    }
                                } catch {
                                }
                            });
                            
                            entry.on('error', () => {
                            });
                        } else {
                            entry.autodrain();
                        }
                    });
                    
                    stream.on('finish', () => {
                        if (!resolved) {
                            resolveOnce(foundPlaceholders);
                        }
                    });
                    
                    stream.on('error', () => {
                        resolveOnce(true);
                    });
                    
                    setTimeout(() => {
                        if (!resolved) {
                            resolveOnce(true);
                        }
                    }, 5000);
                });
            } catch {
                placeholderCache.set(cacheKey, true);
                return true;
            }
        }

        async function processZipFile(zipFilePath, replacements, depth = 0) {
            const fileName = path.basename(zipFilePath);
            
            if (!shouldProcessArchive(fileName, depth)) {
                if (depth === 1 && config.DebugMode) console.log(`Skipping library: ${fileName}`);
                return zipFilePath;
            }
            
            if (depth === 1) {
                const hasPlaceholders = await quickScanJarForPlaceholders(zipFilePath);
                if (!hasPlaceholders) {
                    return zipFilePath;
                }
            }
            
            const tempZipPath = path.join(path.dirname(zipFilePath), generateUniqueFilename(path.basename(zipFilePath)));
            tempFiles.add(tempZipPath);
        
            const output = fsSync.createWriteStream(tempZipPath);
            const archive = archiver('zip', { 
                level: 0,
                store: true
            });
            
            const timeoutDuration = depth === 0 ? 60000 : 15000;
        
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error(`ZIP processing timeout after ${timeoutDuration / 1000} seconds`));
                }, timeoutDuration);

                archive.on('error', (err) => {
                    clearTimeout(timeout);
                    resolve(zipFilePath);
                });
        
                output.on('close', () => {
                    clearTimeout(timeout);
                    if (depth === 0 && config.DebugMode) console.log(`Completed processing: ${fileName}`);
                    
                    if (placeholderFound) {
                        processedFileCache.set(fileKey, tempZipPath);
                        resolve(tempZipPath);
                    } else {
                        resolve(zipFilePath);
                    }
                });

                output.on('error', (err) => {
                    clearTimeout(timeout);
                    reject(err);
                });
        
                archive.pipe(output);

                let pendingEntries = 0;
                let finishedReading = false;

                const checkComplete = () => {
                    if (finishedReading && pendingEntries === 0) {
                        archive.finalize();
                    }
                };

                const textFileExtensions = /\.(txt|js|json|md|yml|yaml|xml|properties|config|java)$/i;
                const classFileExtensions = /\.(class)$/i;
                const archiveExtensions = /\.(zip|jar|war)$/i;

                const entryPromises = [];

                fsSync.createReadStream(zipFilePath)
                    .pipe(unzipper.Parse())
                    .on('entry', (entry) => {
                        pendingEntries++;

                        if (entry.type === 'Directory') {
                            archive.append(null, { name: entry.path + '/' });
                            entry.autodrain();
                            pendingEntries--;
                            checkComplete();
                            return;
                        }

                        const isTextFile = textFileExtensions.test(entry.path);
                        const isClassFile = classFileExtensions.test(entry.path);
                        const isNestedArchive = archiveExtensions.test(entry.path);
                        const entrySize = entry.uncompressedSize || 0;

                        if (!isTextFile && !isClassFile && !isNestedArchive) {
                            archive.append(entry, { name: entry.path });
                            entry.on('end', () => {
                                pendingEntries--;
                                checkComplete();
                            });
                            entry.on('error', () => {
                                pendingEntries--;
                                checkComplete();
                            });
                            return;
                        }

                        if (entrySize > 1024 * 1024) {
                            archive.append(entry, { name: entry.path });
                            entry.on('end', () => {
                                pendingEntries--;
                                checkComplete();
                            });
                            entry.on('error', () => {
                                pendingEntries--;
                                checkComplete();
                            });
                            return;
                        }

                        if (isNestedArchive && !shouldProcessArchive(path.basename(entry.path), depth + 1)) {
                            archive.append(entry, { name: entry.path });
                            entry.on('end', () => {
                                pendingEntries--;
                                checkComplete();
                            });
                            entry.on('error', () => {
                                pendingEntries--;
                                checkComplete();
                            });
                            return;
                        }

                        const processEntry = async () => {
                            const chunks = [];
                            
                            entry.on('data', (chunk) => {
                                chunks.push(chunk);
                            });

                            entry.on('end', async () => {
                                try {
                                    const content = Buffer.concat(chunks);

                                    if (isNestedArchive) {
                                        const nestedTempPath = path.join(path.dirname(tempZipPath), generateUniqueFilename(path.basename(entry.path)));
                                        await fs.writeFile(nestedTempPath, content);
                                        tempFiles.add(nestedTempPath);

                                        const processedNestedPath = await processZipFile(nestedTempPath, replacements, depth + 1);
                                        const processedContent = await fs.readFile(processedNestedPath);
                                        archive.append(processedContent, { name: entry.path });
                                    } else if (isClassFile) {
                                        const processedContent = replacePlaceholdersInBinary(content, replacements);
                                        archive.append(processedContent, { name: entry.path });
                                    } else if (isTextFile) {
                                        try {
                                            const textContent = content.toString('utf8');
                                            const processedContent = replacePlaceholders(textContent, replacements);
                                            archive.append(processedContent, { name: entry.path });
                                        } catch (encodingError) {
                                            archive.append(content, { name: entry.path });
                                        }
                                    } else {
                                        archive.append(content, { name: entry.path });
                                    }

                                    pendingEntries--;
                                    checkComplete();
                                } catch (entryError) {
                                    archive.append(content || Buffer.alloc(0), { name: entry.path });
                                    pendingEntries--;
                                    checkComplete();
                                }
                            });

                            entry.on('error', (err) => {
                                entry.autodrain();
                                pendingEntries--;
                                checkComplete();
                            });
                        };

                        entryPromises.push(processEntry());
                    })
                    .on('finish', () => {
                        finishedReading = true;
                        checkComplete();
                    })
                    .on('error', (err) => {
                        clearTimeout(timeout);
                        resolve(zipFilePath);
                    });
            });
        }

        if (filePath.match(/\.(zip|jar|war)$/i)) {
            return await processZipFile(filePath, replacements);
        } else {
            const content = await fs.readFile(filePath, 'utf8');
            const processedContent = replacePlaceholders(content, replacements);

            if (!placeholderFound) {
                return filePath;
            }

            const tempFilePath = path.join(path.dirname(filePath), generateUniqueFilename(path.basename(filePath)));
            tempFiles.add(tempFilePath);

            await fs.writeFile(tempFilePath, processedContent);
            processedFileCache.set(fileKey, tempFilePath);
            return tempFilePath;
        }
    } catch (error) {
        console.error('Error processing file with placeholders:', error);
        throw error;
    }
};

exports.processFileWithPlaceholdersOptimized = async function (filePath, replacements, placeholderLocations = null, hasPlaceholders = false) {
    try {
        if (!hasPlaceholders || !placeholderLocations || placeholderLocations.length === 0) {
            return filePath;
        }

        let placeholderFound = false;
        const fileStats = await fs.stat(filePath);
        
        if (fileStats.size > 5 * 1024 * 1024 * 1024) {
            console.warn('File too large for placeholder processing (>5GB):', filePath);
            return filePath;
        }
        
        const fileKey = `${filePath}-${fileStats.mtime.getTime()}-${fileStats.size}`;
        if (processedFileCache.has(fileKey)) {
            const cachedResult = processedFileCache.get(fileKey);
            if (fsSync.existsSync(cachedResult)) {
                return cachedResult;
            } else {
                processedFileCache.delete(fileKey);
            }
        }

        function generateUniqueFilename(baseName) {
            const randomBytes = crypto.randomBytes(4).toString('hex');
            const timestamp = Date.now().toString(36);
            return `temp-${timestamp}-${randomBytes}-${baseName}`;
        }

        const placeholderRegex = /%%__(\w+)__%%/g;
        
        function replacePlaceholders(content, replacements) {
            return content.replace(placeholderRegex, (match, placeholder) => {
                if (replacements[placeholder]) {
                    placeholderFound = true;
                    return replacements[placeholder];
                }
                return match;
            });
        }

        function replacePlaceholdersInBinary(buffer, replacements) {
            let modified = false;
            const bufferStr = buffer.toString('binary');
            const newStr = bufferStr.replace(placeholderRegex, (match, placeholder) => {
                if (replacements[placeholder]) {
                    modified = true;
                    placeholderFound = true;
                    return replacements[placeholder];
                }
                return match;
            });
            
            return modified ? Buffer.from(newStr, 'binary') : buffer;
        }

        async function processZipFileOptimized(zipFilePath, replacements, placeholderArray) {
            const pathsToProcess = new Set(placeholderArray.map(f => f.filePath));
            
            if (pathsToProcess.size === 0) {
                return zipFilePath;
            }

            const tempZipPath = path.join(path.dirname(zipFilePath), generateUniqueFilename(path.basename(zipFilePath)));
            tempFiles.add(tempZipPath);
        
            const output = fsSync.createWriteStream(tempZipPath);
            const archive = archiver('zip', { 
                level: 0,
                store: true
            });
        
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error(`ZIP processing timeout after 60 seconds`));
                }, 60000);

                archive.on('error', (err) => {
                    clearTimeout(timeout);
                    resolve(zipFilePath);
                });
        
                output.on('close', () => {
                    clearTimeout(timeout);
                    if (config.DebugMode) console.log(`Completed optimized processing`);
                    
                    if (placeholderFound) {
                        processedFileCache.set(fileKey, tempZipPath);
                        resolve(tempZipPath);
                    } else {
                        resolve(zipFilePath);
                    }
                });

                output.on('error', (err) => {
                    clearTimeout(timeout);
                    reject(err);
                });
        
                archive.pipe(output);

                let pendingEntries = 0;
                let finishedReading = false;

                const checkComplete = () => {
                    if (finishedReading && pendingEntries === 0) {
                        archive.finalize();
                    }
                };

                fsSync.createReadStream(zipFilePath)
                    .pipe(unzipper.Parse())
                    .on('entry', (entry) => {
                        pendingEntries++;

                        if (entry.type === 'Directory') {
                            archive.append(null, { name: entry.path + '/' });
                            entry.autodrain();
                            pendingEntries--;
                            checkComplete();
                            return;
                        }

                        const shouldProcess = pathsToProcess.has(entry.path);

                        if (!shouldProcess) {
                            archive.append(entry, { name: entry.path });
                            entry.on('end', () => {
                                pendingEntries--;
                                checkComplete();
                            });
                            entry.on('error', () => {
                                pendingEntries--;
                                checkComplete();
                            });
                            return;
                        }

                        const chunks = [];
                        
                        entry.on('data', (chunk) => {
                            chunks.push(chunk);
                        });

                        entry.on('end', async () => {
                            try {
                                const content = Buffer.concat(chunks);
                                const fileInfo = placeholderArray.find(f => f.filePath === entry.path);

                                if (fileInfo && fileInfo.isBinary) {
                                    const processedContent = replacePlaceholdersInBinary(content, replacements);
                                    archive.append(processedContent, { name: entry.path });
                                } else {
                                    try {
                                        const textContent = content.toString('utf8');
                                        const processedContent = replacePlaceholders(textContent, replacements);
                                        archive.append(processedContent, { name: entry.path });
                                    } catch (encodingError) {
                                        archive.append(content, { name: entry.path });
                                    }
                                }

                                pendingEntries--;
                                checkComplete();
                            } catch (entryError) {
                                archive.append(content || Buffer.alloc(0), { name: entry.path });
                                pendingEntries--;
                                checkComplete();
                            }
                        });

                        entry.on('error', (err) => {
                            entry.autodrain();
                            pendingEntries--;
                            checkComplete();
                        });
                    })
                    .on('finish', () => {
                        finishedReading = true;
                        checkComplete();
                    })
                    .on('error', (err) => {
                        clearTimeout(timeout);
                        resolve(zipFilePath);
                    });
            });
        }

        if (filePath.match(/\.(zip|jar|war)$/i)) {
            return await processZipFileOptimized(filePath, replacements, placeholderLocations);
        } else {
            const content = await fs.readFile(filePath, 'utf8');
            const processedContent = replacePlaceholders(content, replacements);

            if (!placeholderFound) {
                return filePath;
            }

            const tempFilePath = path.join(path.dirname(filePath), generateUniqueFilename(path.basename(filePath)));
            tempFiles.add(tempFilePath);

            await fs.writeFile(tempFilePath, processedContent);
            processedFileCache.set(fileKey, tempFilePath);
            return tempFilePath;
        }
    } catch (error) {
        console.error('Error processing file with placeholders:', error);
        throw error;
    }
};

exports.generateNonce = async function () {
    const randomPart = crypto.randomBytes(6).toString('base64url');
    const timestampPart = Date.now().toString(36).slice(-6);
    return (randomPart + timestampPart).slice(0, 16);
};