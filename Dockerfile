# Netarium Docker Image (#59)
FROM php:8.5-apache

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        curl iputils-ping openssl \
        libfreetype6-dev libjpeg62-turbo-dev libpng-dev \
        libicu-dev libonig-dev libzip-dev; \
    docker-php-ext-configure gd --with-freetype --with-jpeg; \
    docker-php-ext-install -j"$(nproc)" gd exif intl mbstring zip; \
    a2enmod headers; \
    # sqlite.org 3.54.1 (2026-10-16); checksum verified against official download page.
    curl -fsSLo /tmp/sqlite.tar.gz https://sqlite.org/2026/sqlite-autoconf-3540100.tar.gz; \
    test "$(openssl dgst -sha3-256 /tmp/sqlite.tar.gz | awk '{print $NF}')" = "b6ced585c750916b1052667239a12c25a7ff34e7f06e1e6e01ecb0427657d9c4"; \
    mkdir /tmp/sqlite; \
    tar -xzf /tmp/sqlite.tar.gz -C /tmp/sqlite --strip-components=1; \
    cd /tmp/sqlite; \
    CPPFLAGS=-DSQLITE_ENABLE_COLUMN_METADATA=1 ./configure --prefix=/usr/local --enable-shared --disable-static; \
    make -j"$(nproc)"; \
    make install; \
    ldconfig; \
    cd /var/www/html; \
    php -r 'if (version_compare(SQLite3::version()["versionString"], "3.51.3", "<")) { fwrite(STDERR, "SQLite 3.51.3+ required\\n"); exit(1); }'; \
    rm -rf /tmp/sqlite /tmp/sqlite.tar.gz /var/lib/apt/lists/*

WORKDIR /var/www/html

# Explicit COPY keeps host-specific config/app.php, .env and runtime files outside the image.
COPY bootstrap.php version.php ./
COPY public/ public/
COPY src/ src/
COPY templates/ templates/
COPY resources/ resources/
COPY scripts/ scripts/
COPY docker/apache.conf /etc/apache2/conf-available/netarium.conf
COPY docker/php.ini /usr/local/etc/php/conf.d/netarium.ini

RUN set -eux; \
    sed -ri 's!/var/www/html!/var/www/html/public!g; s/<VirtualHost \*:80>/<VirtualHost *:8080>/g' /etc/apache2/sites-available/000-default.conf; \
    sed -ri 's/^Listen 80$/Listen 8080/' /etc/apache2/ports.conf; \
    a2enconf netarium; \
    mkdir -p /var/lib/netarium/db/csv-import \
        /var/lib/netarium/uploads/floorplans \
        /var/lib/netarium/uploads/device_images \
        /var/lib/netarium/cache/thumbnails \
        /var/lib/netarium/temp/backup-export \
        /var/lib/netarium/temp/backup-restore \
        /var/lib/netarium/backups/auto \
        /var/lib/netarium/logs/audit \
        /var/lib/netarium/sessions \
        /var/run/apache2 /var/lock/apache2 /var/log/apache2; \
    # Pre-create before Docker initializes its named volume (copy-up).
    # A privileged one-shot bootstrap must not create a root-owned 0644 lock.
    touch /var/lib/netarium/temp/operation.lock; \
    chown -R www-data:www-data \
        /var/lib/netarium /var/run/apache2 /var/lock/apache2 /var/log/apache2; \
    chmod 0700 /var/lib/netarium/sessions; \
    chmod 0600 /var/lib/netarium/temp/operation.lock; \
    # Verify mod_php can resolve SQLite symbols before running the container.
    apache2ctl -t

ENV NETARIUM_STORAGE_DIR=/var/lib/netarium \
    NETARIUM_DB_FILE=/var/lib/netarium/db/data.sqlite

# Apache master and workers both run without root privileges.
USER www-data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f -s -S http://127.0.0.1:8080/healthcheck.php || exit 1
