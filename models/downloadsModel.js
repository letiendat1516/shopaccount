const mongoose = require('mongoose');

const downloadSchema = new mongoose.Schema({
    productName: { 
        type: String, 
        required: true 
    },
    productId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Product' 
    },
    versionId: { 
        type: String 
    },
    versionNumber: { 
        type: String 
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    discordUserId: { 
        type: String,
        sparse: true
    },
    discordUsername: { 
        type: String 
    },
    username: {
        type: String
    },
    nonce: { 
        type: String, 
        required: true, 
        unique: true 
    },
    downloadDate: { 
        type: Date, 
        default: Date.now 
    },
    ipAddress: { 
        type: String 
    },
    userAgent: { 
        type: String 
    },
    downloadCompleted: { 
        type: Boolean, 
        default: false 
    },
    downloadAttemptTime: { 
        type: Number 
    },
    downloadCompletionTime: { 
        type: Number 
    },
    timeToDownload: { 
        type: Number 
    },
    fileSize: { 
        type: Number 
    },
    error: { 
        type: String 
    },
    paymentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Payment'
    },
    transactionId: {
        type: String
    }
}, { timestamps: true });

module.exports = mongoose.model('Download', downloadSchema);