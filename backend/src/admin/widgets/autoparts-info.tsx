import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Container, Heading, Input, Label, Select, Button, Text } from "@medusajs/ui"
import { useState } from "react"

type AutopartsMetadata = {
  car_make: string
  car_model: string
  year_from: string
  year_to: string
  oem: string
  condition: string
  sku_internal: string
}

const CAR_MAKES = ["Renault", "Peugeot", "Citroën", "Fiat"]
const CONDITIONS = [
  { value: "new", label: "Новий" },
  { value: "used", label: "Б/У" },
  { value: "refurbished", label: "Відновлений" },
]

function AutopartsWidget({ data }: { data: { id: string; metadata?: Record<string, unknown> | null } }) {
  const meta = (data.metadata ?? {}) as Partial<AutopartsMetadata>

  const [carMake, setCarMake] = useState(meta.car_make ?? "")
  const [carModel, setCarModel] = useState(meta.car_model ?? "")
  const [yearFrom, setYearFrom] = useState(meta.year_from ?? "")
  const [yearTo, setYearTo] = useState(meta.year_to ?? "")
  const [oem, setOem] = useState(meta.oem ?? "")
  const [condition, setCondition] = useState(meta.condition ?? "")
  const [skuInternal, setSkuInternal] = useState(meta.sku_internal ?? "")
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      const response = await fetch(`/admin/products/${data.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          metadata: {
            car_make: carMake,
            car_model: carModel,
            year_from: yearFrom,
            year_to: yearTo,
            oem,
            condition,
            sku_internal: skuInternal,
          },
        }),
      })
      if (response.ok) {
        setSaved(true)
        setTimeout(() => setSaved(false), 3000)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Дані автозапчастини</Heading>
      </div>

      <div className="grid grid-cols-1 gap-4 px-6 py-4 md:grid-cols-2">
        {/* Марка авто */}
        <div className="flex flex-col gap-y-1">
          <Label htmlFor="car_make" size="small" weight="plus">
            Марка авто
          </Label>
          <Select value={carMake} onValueChange={setCarMake}>
            <Select.Trigger id="car_make">
              <Select.Value placeholder="Оберіть марку" />
            </Select.Trigger>
            <Select.Content>
              {CAR_MAKES.map((make) => (
                <Select.Item key={make} value={make}>
                  {make}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        </div>

        {/* Модель авто */}
        <div className="flex flex-col gap-y-1">
          <Label htmlFor="car_model" size="small" weight="plus">
            Модель авто
          </Label>
          <Input
            id="car_model"
            placeholder="Наприклад: Clio IV"
            value={carModel}
            onChange={(e) => setCarModel(e.target.value)}
          />
        </div>

        {/* Рік від */}
        <div className="flex flex-col gap-y-1">
          <Label htmlFor="year_from" size="small" weight="plus">
            Рік від
          </Label>
          <Input
            id="year_from"
            type="number"
            placeholder="2012"
            min={1990}
            max={2030}
            value={yearFrom}
            onChange={(e) => setYearFrom(e.target.value)}
          />
        </div>

        {/* Рік до */}
        <div className="flex flex-col gap-y-1">
          <Label htmlFor="year_to" size="small" weight="plus">
            Рік до
          </Label>
          <Input
            id="year_to"
            type="number"
            placeholder="2019"
            min={1990}
            max={2030}
            value={yearTo}
            onChange={(e) => setYearTo(e.target.value)}
          />
        </div>

        {/* OEM номер */}
        <div className="flex flex-col gap-y-1">
          <Label htmlFor="oem" size="small" weight="plus">
            OEM номер
          </Label>
          <Input
            id="oem"
            placeholder="Наприклад: 260100204R"
            value={oem}
            onChange={(e) => setOem(e.target.value)}
          />
        </div>

        {/* Стан */}
        <div className="flex flex-col gap-y-1">
          <Label htmlFor="condition" size="small" weight="plus">
            Стан
          </Label>
          <Select value={condition} onValueChange={setCondition}>
            <Select.Trigger id="condition">
              <Select.Value placeholder="Оберіть стан" />
            </Select.Trigger>
            <Select.Content>
              {CONDITIONS.map((c) => (
                <Select.Item key={c.value} value={c.value}>
                  {c.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        </div>

        {/* Артикул */}
        <div className="flex flex-col gap-y-1 md:col-span-2">
          <Label htmlFor="sku_internal" size="small" weight="plus">
            Артикул (внутрішній)
          </Label>
          <Input
            id="sku_internal"
            placeholder="Ваш внутрішній артикул"
            value={skuInternal}
            onChange={(e) => setSkuInternal(e.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-x-2 px-6 py-4">
        {saved && (
          <Text size="small" className="text-ui-fg-success">
            Збережено!
          </Text>
        )}
        <Button
          variant="primary"
          size="small"
          onClick={handleSave}
          isLoading={saving}
        >
          Зберегти дані запчастини
        </Button>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "product.details.side.before",
})

export default AutopartsWidget
