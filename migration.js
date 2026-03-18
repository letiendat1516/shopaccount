const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const MIGRATION_FLAG_FILE = path.join(__dirname, '.migration_completed');

async function hasBeenMigrated() {
  return fs.existsSync(MIGRATION_FLAG_FILE);
}

async function markMigrationComplete() {
  fs.writeFileSync(MIGRATION_FLAG_FILE, new Date().toISOString());
}

async function needsMigration() {
  try {
    const userModel = require('./models/userModel');
    const paymentModel = require('./models/paymentModel');
    const downloadsModel = require('./models/downloadsModel');
    const reviewModel = require('./models/reviewModel');

    const checks = await Promise.all([
      userModel.countDocuments({ authMethod: { $exists: false } }),
      paymentModel.countDocuments({ 
        $or: [
          { userId: { $exists: false } },
          { totalPaid: { $exists: false } },
          { totalPaid: 0 }
        ]
      }),
      downloadsModel.countDocuments({ userId: { $exists: false } }),
      reviewModel.countDocuments({ userId: { $exists: false } })
    ]);

    const [usersNeedMigration, paymentsNeedMigration, downloadsNeedMigration, reviewsNeedMigration] = checks;
    const totalNeedingMigration = usersNeedMigration + paymentsNeedMigration + downloadsNeedMigration + reviewsNeedMigration;

    return {
      needed: totalNeedingMigration > 0,
      counts: {
        users: usersNeedMigration,
        payments: paymentsNeedMigration,
        downloads: downloadsNeedMigration,
        reviews: reviewsNeedMigration
      }
    };
  } catch (error) {
    return { needed: false, counts: {} };
  }
}

async function runMigration(config) {
  try {
    if (await hasBeenMigrated()) {
      return;
    }

    const migrationCheck = await needsMigration();
    
    if (!migrationCheck.needed) {
      await markMigrationComplete();
      return;
    }

    console.log('🔄 Migration needed for existing data:');
    if (migrationCheck.counts.users > 0) console.log(`   • ${migrationCheck.counts.users} users`);
    if (migrationCheck.counts.payments > 0) console.log(`   • ${migrationCheck.counts.payments} payments`);
    if (migrationCheck.counts.downloads > 0) console.log(`   • ${migrationCheck.counts.downloads} downloads`);
    if (migrationCheck.counts.reviews > 0) console.log(`   • ${migrationCheck.counts.reviews} reviews`);
    console.log('\n🔄 Starting database migration...\n');

    const userModel = require('./models/userModel');
    const paymentModel = require('./models/paymentModel');
    const downloadsModel = require('./models/downloadsModel');
    const reviewModel = require('./models/reviewModel');

    if (migrationCheck.counts.users > 0) {
      console.log('🔄 Migrating users...');
      const userResult = await userModel.updateMany(
        { authMethod: { $exists: false } },
        { 
          $set: { 
            authMethod: 'discord',
            emailVerified: true
          } 
        }
      );
      console.log(`✅ Updated ${userResult.modifiedCount} users with authMethod: 'discord'`);
    }
    if (migrationCheck.counts.payments > 0) {
      console.log('\n🔄 Migrating payments...');
      const payments = await paymentModel.find({ 
        $or: [
          { userId: { $exists: false } },
          { totalPaid: { $exists: false } },
          { discountAmount: { $exists: false } },
          { salesTaxAmount: { $exists: false } },
          { originalSubtotal: { $exists: false } },
          { totalPaid: 0 }
        ]
      });
      let paymentCount = 0;
      
      for (const payment of payments) {
        try {
          const user = await userModel.findOne({ discordID: payment.userID });
          
          if (user) {
            if (!payment.userId) {
              payment.userId = user._id;
            }
            
            if (!payment.discordID) {
              payment.discordID = user.discordID;
            }
            
            if (!payment.authMethod) {
              payment.authMethod = user.authMethod || 'discord';
            }
          } else {
            console.warn(`⚠️  User not found for payment ${payment.ID} (userID: ${payment.userID})`);
            payment.userId = null;
            payment.authMethod = 'discord';
          }
          
          if (!payment.totalPaid || payment.totalPaid === 0 || payment.totalPaid === undefined) {
            payment.totalPaid = payment.totalPrice || 0;
          }
          
          if (!payment.originalSubtotal || payment.originalSubtotal === undefined) {
            let subtotal = 0;
            if (payment.products && payment.products.length > 0) {
              subtotal = payment.products.reduce((sum, p) => sum + (p.originalPrice || p.price || 0), 0);
            } else {
              subtotal = payment.totalPaid || 0;
            }
            payment.originalSubtotal = subtotal;
          }
          
          if (!payment.discountAmount || payment.discountAmount === undefined) {
            if (payment.discountPercentage && payment.discountPercentage > 0) {
              payment.discountAmount = (payment.originalSubtotal * payment.discountPercentage) / 100;
            } else {
              payment.discountAmount = 0;
            }
          }
          
          if (!payment.salesTaxAmount || payment.salesTaxAmount === undefined) {
            const discountedSubtotal = payment.originalSubtotal - payment.discountAmount;
            if (payment.salesTax && payment.salesTax > 0) {
              payment.salesTaxAmount = (discountedSubtotal * payment.salesTax) / 100;
            } else {
              const expectedWithoutTax = discountedSubtotal;
              const difference = payment.totalPaid - expectedWithoutTax;
              payment.salesTaxAmount = difference > 0 ? difference : 0;
            }
          }
          
          if (payment.totalPaid === 0) {
            const calculatedTotal = payment.originalSubtotal - payment.discountAmount + payment.salesTaxAmount;
            payment.totalPaid = parseFloat(calculatedTotal.toFixed(2));
          }
          
          await payment.save({ validateBeforeSave: false });
          paymentCount++;
          
          if (paymentCount % 10 === 0) {
            console.log(`   Progress: ${paymentCount}/${payments.length} payments migrated...`);
          }
        } catch (error) {
          console.error(`❌ Error migrating payment ${payment.ID}:`, error.message);
        }
      }
      console.log(`✅ Migrated ${paymentCount} payments`);
    }

    if (migrationCheck.counts.downloads > 0) {
      console.log('\n🔄 Migrating downloads...');
      const downloads = await downloadsModel.find({ userId: { $exists: false } });
      let downloadCount = 0;
      
      for (const download of downloads) {
        try {
          const user = await userModel.findOne({ discordID: download.discordUserId });
          if (user) {
            download.userId = user._id;
            download.username = user.username || user.discordUsername;
            await download.save();
            downloadCount++;
            
            if (downloadCount % 50 === 0) {
              console.log(`   Progress: ${downloadCount}/${downloads.length} downloads migrated...`);
            }
          } else {
            console.warn(`⚠️  User not found for download (discordUserId: ${download.discordUserId})`);
          }
        } catch (error) {
          console.error(`❌ Error migrating download:`, error.message);
        }
      }
      console.log(`✅ Migrated ${downloadCount} downloads`);
    }

    if (migrationCheck.counts.reviews > 0) {
      console.log('\n🔄 Migrating reviews...');
      const reviews = await reviewModel.find({ userId: { $exists: false } });
      let reviewCount = 0;
      
      for (const review of reviews) {
        try {
          const user = await userModel.findOne({ discordID: review.discordID });
          if (user) {
            review.userId = user._id;
            review.username = user.username || user.discordUsername;
            await review.save();
            reviewCount++;
          } else {
            console.warn(`⚠️  User not found for review (discordID: ${review.discordID})`);
          }
        } catch (error) {
          console.error(`❌ Error migrating review:`, error.message);
        }
      }
      console.log(`✅ Migrated ${reviewCount} reviews`);
    }

    await markMigrationComplete();
    console.log('\n🎉 Migration completed successfully!\n');
    
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    throw error;
  }
}

module.exports = { runMigration, hasBeenMigrated };