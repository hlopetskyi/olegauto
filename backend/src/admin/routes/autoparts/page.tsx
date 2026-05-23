import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Container, Heading, Text, Badge } from "@medusajs/ui"
import { Car, PencilSquare, ShoppingCart } from "@medusajs/icons"
import { useEffect, useState } from "react"

type ProductStats = {
  total: number
  newParts: number
  usedParts: number
  refurbishedParts: number
}

function StatCard({
  title,
  value,
  description,
  variant = "default",
}: {
  title: string
  value: number | string
  description?: string
  variant?: "default" | "success" | "orange"
}) {
  const borderColor =
    variant === "success"
      ? "border-l-ui-tag-green-border"
      : variant === "orange"
        ? "border-l-ui-tag-orange-border"
        : "border-l-ui-border-strong"

  return (
    <Container className={`border-l-4 ${borderColor} p-4`}>
      <Text size="small" weight="plus" className="text-ui-fg-subtle">
        {title}
      </Text>
      <Heading level="h1" className="mt-1 text-ui-fg-base">
        {value}
      </Heading>
      {description && (
        <Text size="xsmall" className="mt-1 text-ui-fg-muted">
          {description}
        </Text>
      )}
    </Container>
  )
}

function QuickLinkCard({
  title,
  description,
  href,
  icon: Icon,
}: {
  title: string
  description: string
  href: string
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <a
      href={href}
      className="flex items-start gap-x-3 rounded-lg border border-ui-border-base bg-ui-bg-base p-4 transition-colors hover:bg-ui-bg-base-hover"
    >
      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-ui-bg-component">
        <Icon className="h-5 w-5 text-ui-fg-subtle" />
      </div>
      <div>
        <Text weight="plus" size="small" className="text-ui-fg-base">
          {title}
        </Text>
        <Text size="xsmall" className="mt-0.5 text-ui-fg-muted">
          {description}
        </Text>
      </div>
    </a>
  )
}

export default function AutopartsPage() {
  const [stats, setStats] = useState<ProductStats>({
    total: 0,
    newParts: 0,
    usedParts: 0,
    refurbishedParts: 0,
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchStats() {
      try {
        const response = await fetch("/admin/products?limit=500&fields=id,metadata", {
          credentials: "include",
        })
        if (response.ok) {
          const data = await response.json()
          const products = data.products ?? []

          const total = products.length
          const newParts = products.filter(
            (p: { metadata?: { condition?: string } }) => p.metadata?.condition === "new"
          ).length
          const usedParts = products.filter(
            (p: { metadata?: { condition?: string } }) => p.metadata?.condition === "used"
          ).length
          const refurbishedParts = products.filter(
            (p: { metadata?: { condition?: string } }) => p.metadata?.condition === "refurbished"
          ).length

          setStats({ total, newParts, usedParts, refurbishedParts })
        }
      } catch (error) {
        console.error("Failed to fetch product stats:", error)
      } finally {
        setLoading(false)
      }
    }

    fetchStats()
  }, [])

  return (
    <div className="flex flex-col gap-y-6 p-6">
      {/* Header */}
      <div>
        <Heading level="h1" className="text-ui-fg-base">
          Автозапчастини — панель управління
        </Heading>
        <Text size="small" className="mt-1 text-ui-fg-subtle">
          OlegAuto — Запчастини для Renault, Peugeot, Citroën, Fiat
        </Text>
      </div>

      {/* Stats */}
      <div>
        <Heading level="h2" className="mb-3 text-ui-fg-base">
          Статистика товарів
        </Heading>
        {loading ? (
          <Text size="small" className="text-ui-fg-muted">
            Завантаження...
          </Text>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              title="Всього товарів"
              value={stats.total}
              description="Усі активні позиції"
            />
            <StatCard
              title="Нові запчастини"
              value={stats.newParts}
              description="Товари з condition=new"
              variant="success"
            />
            <StatCard
              title="Б/У запчастини"
              value={stats.usedParts}
              description="Товари з condition=used"
              variant="orange"
            />
            <StatCard
              title="Відновлені"
              value={stats.refurbishedParts}
              description="Товари з condition=refurbished"
            />
          </div>
        )}
      </div>

      {/* Brands */}
      <div>
        <Heading level="h2" className="mb-3 text-ui-fg-base">
          Марки автомобілів
        </Heading>
        <div className="flex flex-wrap gap-2">
          {["Renault", "Peugeot", "Citroën", "Fiat"].map((brand) => (
            <Badge key={brand} color="blue">
              {brand}
            </Badge>
          ))}
        </div>
      </div>

      {/* Quick Links */}
      <div>
        <Heading level="h2" className="mb-3 text-ui-fg-base">
          Швидкі дії
        </Heading>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <QuickLinkCard
            title="Додати товар"
            description="Створити нову запчастину в каталозі"
            href="/app/products/new"
            icon={Car}
          />
          <QuickLinkCard
            title="Всі товари"
            description="Переглянути та редагувати каталог"
            href="/app/products"
            icon={PencilSquare}
          />
          <QuickLinkCard
            title="Замовлення"
            description="Перегляд і обробка замовлень"
            href="/app/orders"
            icon={ShoppingCart}
          />
        </div>
      </div>

      {/* Tips */}
      <Container className="bg-ui-bg-highlight border border-ui-border-base p-4">
        <Heading level="h3" className="mb-2 text-ui-fg-base">
          Підказка
        </Heading>
        <ul className="list-inside list-disc space-y-1">
          <li>
            <Text size="small" className="inline text-ui-fg-subtle">
              Під час додавання товару заповніть блок &quot;Дані автозапчастини&quot; праворуч на сторінці товару.
            </Text>
          </li>
          <li>
            <Text size="small" className="inline text-ui-fg-subtle">
              Вкажіть OEM номер — це допоможе покупцям знайти потрібну деталь.
            </Text>
          </li>
          <li>
            <Text size="small" className="inline text-ui-fg-subtle">
              Додавайте теги з маркою авто (Renault, Peugeot, Citroën, Fiat) для кращої фільтрації.
            </Text>
          </li>
          <li>
            <Text size="small" className="inline text-ui-fg-subtle">
              Ціни вказуються в копійках — наприклад, 3200 грн = 320000.
            </Text>
          </li>
        </ul>
      </Container>
    </div>
  )
}

export const config = defineRouteConfig({
  label: "Автозапчастини",
  icon: Car,
})
