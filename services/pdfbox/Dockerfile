FROM docker.io/library/maven:3.9.9-eclipse-temurin-17 AS build
WORKDIR /src
COPY pom.xml .
RUN mvn -q dependency:go-offline
COPY src ./src
RUN mvn -q -DskipTests package

FROM docker.io/library/eclipse-temurin:17-jre-jammy
# WenQuanYi Micro Hei: TrueType font with Latin + Chinese glyphs, embedded as a
# subset whenever written text is not plain Latin.
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-wqy-microhei \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin openpdf
WORKDIR /app
COPY --from=build /src/target/pdfbox-service-0.1.0.jar /app/app.jar
# BIND_HOST: the gateway reaches this service from its own container (only the
# gateway's port is published on the host).
ENV PORT=8092 \
    BIND_HOST=0.0.0.0 \
    CJK_FONT_PATH=/usr/share/fonts/truetype/wqy/wqy-microhei.ttc \
    JAVA_TOOL_OPTIONS="-Xms64m -Xmx2g -XX:+UseG1GC -XX:ParallelGCThreads=2 -XX:ConcGCThreads=1 -XX:G1PeriodicGCInterval=30000 -XX:+UseStringDeduplication -Djava.awt.headless=true --add-opens=java.base/java.nio=ALL-UNNAMED --add-opens=java.base/jdk.internal.ref=ALL-UNNAMED"
USER openpdf
EXPOSE 8092
CMD ["java", "-jar", "/app/app.jar"]
