import {
  ExecArgs,
} from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { createProductsWorkflow } from "@medusajs/medusa/core-flows"

export default async function seedDatabase({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  logger.info("Starting OlegAuto seed...")

  // ─── Services ────────────────────────────────────────────────────────────────
  const regionModuleService = container.resolve(Modules.REGION)
  const salesChannelModuleService = container.resolve(Modules.SALES_CHANNEL)
  const productModuleService = container.resolve(Modules.PRODUCT)
  const inventoryModuleService = container.resolve(Modules.INVENTORY)
  const stockLocationModuleService = container.resolve(Modules.STOCK_LOCATION)
  const pricingModuleService = container.resolve(Modules.PRICING)

  // ─── Region ───────────────────────────────────────────────────────────────────
  logger.info("Creating region Україна...")
  let region = (await regionModuleService.listRegions({ name: "Україна" }))[0]
  if (!region) {
    region = await regionModuleService.createRegions({
      name: "Україна",
      currency_code: "uah",
      countries: ["ua"],
    })
  }
  logger.info(`Region: ${region.id}`)

  // ─── Sales Channel ────────────────────────────────────────────────────────────
  logger.info("Creating sales channel...")
  let salesChannels = await salesChannelModuleService.listSalesChannels({ name: "Основний магазин" })
  let salesChannel = salesChannels[0]
  if (!salesChannel) {
    salesChannel = await salesChannelModuleService.createSalesChannels({
      name: "Основний магазин",
      description: "Основний канал продажів OlegAuto",
    })
  }
  logger.info(`Sales Channel: ${salesChannel.id}`)

  // ─── Stock Location ───────────────────────────────────────────────────────────
  logger.info("Creating stock location...")
  let locations = await stockLocationModuleService.listStockLocations({ name: "Основний склад" })
  let location = locations[0]
  if (!location) {
    location = await stockLocationModuleService.createStockLocations({
      name: "Основний склад",
      address: {
        city: "Київ",
        country_code: "UA",
      },
    })
  }
  logger.info(`Stock Location: ${location.id}`)

  // ─── Product Categories ───────────────────────────────────────────────────────
  logger.info("Creating product categories...")

  const categoryNames = [
    "Освітлення",
    "Кузов",
    "Двигун та КПП",
    "Підвіска",
    "Гальма",
    "Електрика",
    "Інтер'єр",
    "Охолодження",
    "Паливна система",
    "Трансмісія",
  ]

  const categoryMap: Record<string, string> = {}

  for (const name of categoryNames) {
    const existing = await productModuleService.listProductCategories({ name })
    if (existing.length > 0) {
      categoryMap[name] = existing[0].id
      logger.info(`Category exists: ${name} → ${existing[0].id}`)
    } else {
      const cat = await productModuleService.createProductCategories({
        name,
        handle: name
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^\w-]/g, "")
          .replace(/'/g, ""),
        is_active: true,
        is_internal: false,
      })
      categoryMap[name] = cat.id
      logger.info(`Created category: ${name} → ${cat.id}`)
    }
  }

  // ─── Products ─────────────────────────────────────────────────────────────────
  logger.info("Creating products...")

  const products = [
    {
      title: "Фара права Renault Clio IV 2012–2019",
      description: "Оригінальна права фара для Renault Clio IV. Стан: новий. OEM: 260100204R.",
      handle: "fara-prava-renault-clio-iv-2012-2019",
      status: "published" as const,
      category: "Освітлення",
      tags: ["Renault", "Clio IV"],
      metadata: {
        condition: "new",
        oem: "260100204R",
        car_make: "Renault",
        car_model: "Clio IV",
        year_from: "2012",
        year_to: "2019",
      },
      price: 320000, // UAH in smallest unit (kopecks) — 3200 UAH
      quantity: 3,
    },
    {
      title: "Бампер передній Peugeot 308 II 2013–2021",
      description: "Передній бампер для Peugeot 308 II покоління. Стан: б/у, без тріщин.",
      handle: "bumper-peredni-peugeot-308-ii-2013-2021",
      status: "published" as const,
      category: "Кузов",
      tags: ["Peugeot", "308 II"],
      metadata: {
        condition: "used",
        oem: "9809196380",
        car_make: "Peugeot",
        car_model: "308 II",
        year_from: "2013",
        year_to: "2021",
      },
      price: 180000,
      quantity: 1,
    },
    {
      title: "АКПП AL4 Citroën C3 1.4 2002–2009",
      description: "Автоматична коробка передач AL4 для Citroën C3 1.4. Знята з автомобіля 2006 р.в., пробіг 98 000 км.",
      handle: "akpp-al4-citroen-c3-1-4-2002-2009",
      status: "published" as const,
      category: "Двигун та КПП",
      tags: ["Citroën", "C3"],
      metadata: {
        condition: "used",
        oem: "AL4-20DP",
        car_make: "Citroën",
        car_model: "C3",
        year_from: "2002",
        year_to: "2009",
      },
      price: 1200000,
      quantity: 1,
    },
    {
      title: "Стійка передня права Fiat Doblo II 2010–2022",
      description: "Передня права стійка підвіски для Fiat Doblo II. Знята в робочому стані.",
      handle: "stijka-peredna-prava-fiat-doblo-ii-2010-2022",
      status: "published" as const,
      category: "Підвіска",
      tags: ["Fiat", "Doblo II"],
      metadata: {
        condition: "used",
        oem: "51899993",
        car_make: "Fiat",
        car_model: "Doblo II",
        year_from: "2010",
        year_to: "2022",
      },
      price: 240000,
      quantity: 2,
    },
    {
      title: "Гальмівні диски Renault Megane III (комплект)",
      description: "Комплект передніх гальмівних дисків для Renault Megane III. Нові, у заводській упаковці.",
      handle: "galmivni-dysky-renault-megane-iii-komplekt",
      status: "published" as const,
      category: "Гальма",
      tags: ["Renault", "Megane III"],
      metadata: {
        condition: "new",
        oem: "402064EA0A",
        car_make: "Renault",
        car_model: "Megane III",
        year_from: "2008",
        year_to: "2016",
      },
      price: 165000,
      quantity: 5,
    },
    {
      title: "Генератор Peugeot Partner B9 1.6 HDI",
      description: "Генератор для Peugeot Partner B9 з дизельним двигуном 1.6 HDI. Відновлений, гарантія 3 місяці.",
      handle: "generator-peugeot-partner-b9-1-6-hdi",
      status: "published" as const,
      category: "Електрика",
      tags: ["Peugeot", "Partner B9"],
      metadata: {
        condition: "used",
        oem: "5705AH",
        car_make: "Peugeot",
        car_model: "Partner B9",
        year_from: "2008",
        year_to: "2018",
      },
      price: 420000,
      quantity: 1,
    },
    {
      title: "Торпедо (панель приладів) Citroën C4 I",
      description: "Панель приладів (торпедо) для Citroën C4 першого покоління. Знята в задовільному стані.",
      handle: "torpedo-panel-pryladiv-citroen-c4-i",
      status: "published" as const,
      category: "Інтер'єр",
      tags: ["Citroën", "C4 I"],
      metadata: {
        condition: "used",
        oem: "9659688877",
        car_make: "Citroën",
        car_model: "C4 I",
        year_from: "2004",
        year_to: "2010",
      },
      price: 380000,
      quantity: 1,
    },
    {
      title: "Радіатор охолодження Renault Logan II 1.2",
      description: "Новий радіатор охолодження двигуна для Renault Logan II з двигуном 1.2.",
      handle: "radiator-okholodzhennya-renault-logan-ii-1-2",
      status: "published" as const,
      category: "Охолодження",
      tags: ["Renault", "Logan II"],
      metadata: {
        condition: "new",
        oem: "214100494R",
        car_make: "Renault",
        car_model: "Logan II",
        year_from: "2013",
        year_to: "2022",
      },
      price: 210000,
      quantity: 4,
    },
    {
      title: "ТНВД Bosch Fiat Ducato 2.3 JTD",
      description: "Паливний насос високого тиску Bosch для Fiat Ducato 2.3 JTD. Знятий, перевірений.",
      handle: "tnvd-bosch-fiat-ducato-2-3-jtd",
      status: "published" as const,
      category: "Паливна система",
      tags: ["Fiat", "Ducato"],
      metadata: {
        condition: "used",
        oem: "0445010187",
        car_make: "Fiat",
        car_model: "Ducato",
        year_from: "2006",
        year_to: "2014",
      },
      price: 850000,
      quantity: 1,
    },
    {
      title: "Кардан передній Peugeot 406 2.0 HDI",
      description: "Передній карданний вал для Peugeot 406 з двигуном 2.0 HDI. Б/у, без люфтів.",
      handle: "kardan-peredni-peugeot-406-2-0-hdi",
      status: "published" as const,
      category: "Трансмісія",
      tags: ["Peugeot", "406"],
      metadata: {
        condition: "used",
        oem: "3272G4",
        car_make: "Peugeot",
        car_model: "406",
        year_from: "1999",
        year_to: "2004",
      },
      price: 290000,
      quantity: 1,
    },
    {
      title: "Фара ліва Citroën Berlingo B9 2008–2018",
      description: "Ліва передня фара для Citroën Berlingo другого покоління. Б/у, скло без тріщин.",
      handle: "fara-liva-citroen-berlingo-b9-2008-2018",
      status: "published" as const,
      category: "Освітлення",
      tags: ["Citroën", "Berlingo B9"],
      metadata: {
        condition: "used",
        oem: "9808829780",
        car_make: "Citroën",
        car_model: "Berlingo B9",
        year_from: "2008",
        year_to: "2018",
      },
      price: 280000,
      quantity: 2,
    },
    {
      title: "Капот Renault Duster I 2010–2018",
      description: "Капот для Renault Duster першого покоління. Б/у, пофарбований у білий колір (A51).",
      handle: "kapot-renault-duster-i-2010-2018",
      status: "published" as const,
      category: "Кузов",
      tags: ["Renault", "Duster I"],
      metadata: {
        condition: "used",
        oem: "656000001R",
        car_make: "Renault",
        car_model: "Duster I",
        year_from: "2010",
        year_to: "2018",
      },
      price: 350000,
      quantity: 1,
    },
  ]

  for (const productData of products) {
    const { category, tags, price, quantity, metadata, ...rest } = productData

    const categoryId = categoryMap[category]
    if (!categoryId) {
      logger.warn(`Category "${category}" not found, skipping product: ${rest.title}`)
      continue
    }

    // Check if product exists
    const existing = await productModuleService.listProducts({ handle: rest.handle })
    if (existing.length > 0) {
      logger.info(`Product already exists: ${rest.title}`)
      continue
    }

    logger.info(`Creating product: ${rest.title}`)

    // Create product tags
    const tagObjects = tags.map((value) => ({ value }))

    const [product] = await createProductsWorkflow(container).run({
      input: {
        products: [
          {
            ...rest,
            metadata,
            category_ids: [categoryId],
            tags: tagObjects,
            options: [
              {
                title: "Стан",
                values: [metadata.condition === "new" ? "Новий" : metadata.condition === "used" ? "Б/У" : "Відновлений"],
              },
            ],
            variants: [
              {
                title: metadata.condition === "new" ? "Новий" : metadata.condition === "used" ? "Б/У" : "Відновлений",
                sku: `${rest.handle}-${metadata.condition}`,
                manage_inventory: true,
                options: {
                  Стан: metadata.condition === "new" ? "Новий" : metadata.condition === "used" ? "Б/У" : "Відновлений",
                },
                prices: [
                  {
                    amount: price,
                    currency_code: "uah",
                  },
                ],
          inventory_quantity: quantity,
              },
            ],
            sales_channels: [{ id: salesChannel.id }],
          },
        ],
      },
    })

    logger.info(`Created product: ${product.id} — ${rest.title}`)
  }

  logger.info("OlegAuto seed completed successfully!")
}
