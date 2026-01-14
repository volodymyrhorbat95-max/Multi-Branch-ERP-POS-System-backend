const { sequelize, ShippingZone, NeighborhoodMapping, SaleShipping } = require('./src/database/models');

console.log('Testing shipping models...\n');

console.log('Models loaded successfully:');
console.log('- ShippingZone:', !!ShippingZone);
console.log('- NeighborhoodMapping:', !!NeighborhoodMapping);
console.log('- SaleShipping:', !!SaleShipping);

// Test querying data
async function testModels() {
  try {
    const zones = await ShippingZone.findAll({
      include: [{ model: NeighborhoodMapping, as: 'neighborhood_mappings' }]
    });
    console.log(`\nFound ${zones.length} shipping zones`);
    zones.forEach(zone => {
      console.log(`  - ${zone.name}: $${zone.base_rate} (${zone.neighborhood_mappings?.length || 0} neighborhoods)`);
    });

    const mappings = await NeighborhoodMapping.findAll();
    console.log(`\nFound ${mappings.length} neighborhood mappings`);

    await sequelize.close();
    console.log('\n✓ All shipping models working correctly!');
  } catch (error) {
    console.error('\n✗ Error testing models:', error.message);
    process.exit(1);
  }
}

testModels();
