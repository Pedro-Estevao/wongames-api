/**
 * game service
 */

import axios from 'axios';
import { JSDOM } from 'jsdom';
import slugify from 'slugify';
import qs from 'querystring';
import { factories } from '@strapi/strapi';

const gameService = "api::game.game";
const publisherService = "api::publisher.publisher";
const developerService = "api::developer.developer";
const categoryService = "api::category.category";
const platformService = "api::platform.platform";

function timeout(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function Exception(e) {
    return { e, data: e.data && e.data.errors && e.data.errors };
}

async function getGameInfo(slug) {
    try {
        const gogSlug = slug.replaceAll("-", "_").toLowerCase();

        const gogGamePage = `${process.env.GOG_URL}/game/`;

        const body = await axios.get(`${gogGamePage}${gogSlug}`);
        const dom = new JSDOM(body.data);

        const raw_description = dom.window.document.querySelector(".description");

        const description = raw_description.innerHTML;
        const short_description = raw_description.textContent.slice(0, 160);

        const ratingElement = dom.window.document.querySelector(".age-restrictions__icon use");

        return {
            description,
            short_description,
            rating: ratingElement
                ? ratingElement
                    .getAttribute("xlink:href")
                    .replace(/_/g, "")
                    .replace("#", "")
                : "BR0",
        };
    } catch (error) {
        console.log("getGameInfo: ", Exception(error));
    }
}

async function getByName(name, entityService) {
    try {
        const item = await strapi.service(entityService).find({
            filters: { name },
        });

        return item.results.length > 0 ? item.results[0] : null;
    } catch (error) {
        console.log("getByName: ", Exception(error));
    }
}

async function create(name, entityService) {
    try {
        const item = await getByName(name, entityService);

        if (!item) {
            await strapi.service(entityService).create({
                data: {
                    name,
                    slug: slugify(name, { strict: true, lower: true }),
                },
            });
        }
    } catch (error) {
        console.log("create: ", Exception(error));
    }
}

async function createManyToManyData(products) {
    const developersSet = new Set();
    const publishersSet = new Set();
    const categoriesSet = new Set();
    const platformsSet = new Set();

    products.forEach((product) => {
        const { developers, publishers, genres, operatingSystems } = product;

        genres?.forEach(({ name }) => {
            categoriesSet.add(name);
        });

        operatingSystems?.forEach((item) => {
            platformsSet.add(item);
        });

        developers?.forEach((item) => {
            developersSet.add(item);
        });

        publishers?.forEach((item) => {
            publishersSet.add(item);
        });
    });

    const createCall = (set, entityName) => Array.from(set).map((name) => create(name, entityName));

    return Promise.all([
        ...createCall(developersSet, developerService),
        ...createCall(publishersSet, publisherService),
        ...createCall(categoriesSet, categoryService),
        ...createCall(platformsSet, platformService),
    ]);
}

async function setImage({ image, game, field = "cover" }) {
    const { data } = await axios.get(image, { responseType: "arraybuffer" });
    const buffer = Buffer.from(data, "base64");

    const FormData = require("form-data");

    const formData: any = new FormData();

    const generateRandomId = () => {
        const id = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        return id;
    }

    formData.append("refId", game.id);
    formData.append("ref", `${gameService}`);
    formData.append("field", field);
    formData.append("files", buffer, { filename: `${game.slug}_${generateRandomId()}.jpg` });

    console.info(`Uploading ${field} image: ${game.slug}_${generateRandomId()}.jpg`);

    try {
        await axios({
            method: "POST",
            url: `${process.env.APP_URL}/api/upload/`,
            data: formData,
            headers: {
                "Content-Type": `multipart/form-data; boundary=${formData._boundary}`,
            },
        });
    } catch (error) {
        console.log("setImage: ", Exception(error));
    }
}

async function createGames(products) {
    await Promise.all(
        products.map(async (product) => {
            const item = await getByName(product.title, gameService);

            if (!item) {
                console.info(`Creating: ${product.title}...`);

                const game = await strapi.service(`${gameService}`).create({
                    data: {
                        name: product.title,
                        slug: product.slug,
                        price: product.price && product.price.finalMoney.amount || 0.00,
                        release_date: new Date(product.releaseDate),
                        categories: await Promise.all(
                            product.genres.map(({ name }) => getByName(name, categoryService))
                        ),
                        platforms: await Promise.all(
                            product.operatingSystems.map((name) => getByName(name, platformService))
                        ),
                        developers: await Promise.all(
                            product.developers.map((name) => getByName(name, developerService))
                        ),
                        publisher: await Promise.all(
                            product.publishers.map((name) => getByName(name, publisherService))
                        ),
                        ...(await getGameInfo(product.slug)),
                        publishedAt: new Date(),
                    },
                });

                await setImage({ image: product.coverHorizontal, game });
                await Promise.all(
                    product.screenshots.slice(0, 5).map((url) =>
                        setImage({
                            image: `${url.replace("{formatter}", "product_card_v2_mobile_slider_639")}`,
                            game,
                            field: "gallery",
                        })
                    )
                );

                return game;
            }
        })
    );
}

export default factories.createCoreService(gameService, () => ({
    async populate(params) {
        try {
            // const gogApiUrl = `${process.env.GOG_API_URL}?${qs.stringify(params)}`;
            // const gogApiUrl = `${process.env.GOG_API_URL}?limit=50&releaseStatuses=in%3Aupcoming&order=desc%3Atrending&productType=in%3Agame%2Cpack%2Cdlc%2Cextras`;
            const gogApiUrl = `${process.env.GOG_API_URL}?limit=8&query=like%3AHorizon&order=desc%3Ascore&productType=in%3Agame%2Cpack%2Cdlc%2Cextras`;
			
			const {
                data: { products },
            } = await axios.get(gogApiUrl);
    
            await createManyToManyData(products);
            await createGames(products);

        } catch (error) {
            console.log("populate: ", Exception(error));
        }
    },
}));
